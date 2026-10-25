import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { holderCostLedger, ledgerEntries, projects, runs } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";
import { newId } from "../src/lib/id";
import {
  getBalanceMicro,
  listLots,
  recordCreditLot,
  reserve,
  reverseCredit,
  settleRun,
} from "../src/billing/ledger";

async function createProject(): Promise<string> {
  const id = newId("prj");
  await db.insert(projects).values({
    id,
    name: "ledger-test",
    ownerWallet: `0x${id.slice(-40)}`.toLowerCase(),
  });
  return id;
}

async function ledgerSum(projectId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountMicro}), 0)` })
    .from(ledgerEntries)
    .where(sql`${ledgerEntries.projectId} = ${projectId}`);
  return Number(rows[0]?.total ?? 0);
}

describe("ledger", () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = await createProject();
  });

  test("deposit/promo membuat lot & saldo", async () => {
    const first = await recordCreditLot({
      projectId,
      source: "PROMO",
      amountMicro: 1000,
      idempotencyKey: "lot-1",
    });
    const second = await recordCreditLot({
      projectId,
      source: "PROMO",
      amountMicro: 2000,
      idempotencyKey: "lot-2",
    });
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(true);
    expect(await getBalanceMicro(projectId)).toBe(3000);
  });

  test("recordCreditLot idempoten per idempotencyKey", async () => {
    const again = await recordCreditLot({
      projectId,
      source: "PROMO",
      amountMicro: 1000,
      idempotencyKey: "lot-1",
    });
    expect(again.applied).toBe(false);
    expect(await getBalanceMicro(projectId)).toBe(3000);
  });

  test("reserve menolak bila saldo kurang", async () => {
    const result = await reserve({ projectId, runId: "run-x", amountMicro: 1_000_000 });
    expect(result.ok).toBe(false);
    expect(await getBalanceMicro(projectId)).toBe(3000);
  });

  test("reserve menahan saldo", async () => {
    const result = await reserve({ projectId, runId: "run-1", amountMicro: 1500 });
    expect(result.ok).toBe(true);
    expect(await getBalanceMicro(projectId)).toBe(1500);
  });

  test("settleRun melepas hold & konsumsi lot FIFO", async () => {
    await settleRun({
      projectId,
      runId: "run-1",
      reservedMicro: 1500,
      chargedMicro: 1200,
    });
    expect(await getBalanceMicro(projectId)).toBe(1800);
    expect(await ledgerSum(projectId)).toBe(1800);

    const lots = await listLots(projectId);
    expect(lots[0].amountMicro).toBe(1000);
    expect(lots[0].remainingMicro).toBe(0); // lot pertama habis lebih dulu
    expect(lots[1].amountMicro).toBe(2000);
    expect(lots[1].remainingMicro).toBe(1800);
  });

  test("settleRun idempoten", async () => {
    const before = await listLots(projectId);
    await settleRun({
      projectId,
      runId: "run-1",
      reservedMicro: 1500,
      chargedMicro: 1200,
    });
    expect(await getBalanceMicro(projectId)).toBe(1800);
    // Retry tidak boleh mengonsumsi lot lagi (bug lama: remaining_micro turun
    // dua kali walau ledger entry di-skip).
    const after = await listLots(projectId);
    expect(after.map((lot) => lot.remainingMicro)).toEqual(
      before.map((lot) => lot.remainingMicro),
    );
  });

  test("settleRun finalStatus memperbarui run dalam transaksi yang sama", async () => {
    const fresh = await createProject();
    await recordCreditLot({
      projectId: fresh,
      source: "PROMO",
      amountMicro: 5000,
      idempotencyKey: `settle-run-lot-${fresh}`,
    });
    const runId = newId("run");
    await db.insert(runs).values({
      id: runId,
      projectId: fresh,
      recipeId: "refine",
      recipeVersion: 1,
      status: "RUNNING",
      mode: "streaming",
      input: "test",
      idempotencyKey: newId("idem"),
    });
    await reserve({ projectId: fresh, runId, amountMicro: 2000 });

    await settleRun({
      projectId: fresh,
      runId,
      reservedMicro: 2000,
      chargedMicro: 1200,
      finalStatus: "SETTLED",
      output: { ok: true },
      error: null,
      providerCostUsd: 0.01,
    });

    const row = (await db.select().from(runs).where(eq(runs.id, runId)))[0];
    expect(row.status).toBe("SETTLED");
    expect(row.chargedMicro).toBe(1200);
    expect(row.output).toEqual({ ok: true });
    expect(await getBalanceMicro(fresh)).toBe(3800);
  });

  test("settleRun mencatat holder cost atomik dan idempoten", async () => {
    const fresh = await createProject();
    const runId = newId("run");
    await db.insert(runs).values({
      id: runId,
      projectId: fresh,
      recipeId: "refine",
      recipeVersion: 1,
      status: "RUNNING",
      mode: "streaming",
      input: "holder cost",
      isHolder: true,
      holderTier: "pilot",
      idempotencyKey: newId("idem"),
    });

    const input = {
      projectId: fresh,
      runId,
      reservedMicro: 0,
      chargedMicro: 0,
      finalStatus: "SETTLED" as const,
      providerCostUsd: 0.25,
    };
    await settleRun(input);
    await settleRun(input);

    const rows = await db
      .select()
      .from(holderCostLedger)
      .where(eq(holderCostLedger.runId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBe("0.25000000");
    expect(rows[0].wallet).toBe(`0x${fresh.slice(-40)}`.toLowerCase());
    expect(rows[0].tier).toBe("pilot");

    await db.delete(holderCostLedger).where(eq(holderCostLedger.runId, runId));
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(projects).where(eq(projects.id, fresh));
  });

  test("reverseCredit idempoten tidak mengurangi lot dua kali", async () => {
    const fresh = await createProject();
    const lot = await recordCreditLot({
      projectId: fresh,
      source: "PROMO",
      amountMicro: 5000,
      idempotencyKey: `reverse-lot-${fresh}`,
    });
    const key = `reorg:${fresh}`;

    const first = await reverseCredit({
      projectId: fresh,
      lotId: lot.lotId,
      amountMicro: 2000,
      idempotencyKey: key,
    });
    const second = await reverseCredit({
      projectId: fresh,
      lotId: lot.lotId,
      amountMicro: 2000,
      idempotencyKey: key,
    });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(await getBalanceMicro(fresh)).toBe(3000);
    const lots = await listLots(fresh);
    expect(lots[0]?.remainingMicro).toBe(3000);
  });

  test("recordCreditLot konkuren dengan key sama hanya membuat satu lot", async () => {
    const fresh = await createProject();
    const key = `concurrent-lot-${fresh}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        recordCreditLot({
          projectId: fresh,
          source: "PROMO",
          amountMicro: 1000,
          idempotencyKey: key,
        }),
      ),
    );

    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(await getBalanceMicro(fresh)).toBe(1000);
    expect(await listLots(fresh)).toHaveLength(1);
  });
});