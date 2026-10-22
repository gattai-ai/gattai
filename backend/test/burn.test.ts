import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import {
  alignDown,
  burnedTotalTokens,
  computeEpochPlan,
  decimalToTokens18,
  decimalToUsd8,
  enumerateWindows,
  markEpochExecuted,
  planFromMarginRows,
  recordEpoch,
  runBurnCycle,
  shareUsd8,
  tokens18ToDecimalString,
  usd8ToTokens18,
} from "../src/burn";
import {
  BurnUnavailableError,
  DryRunExecutor,
  OnchainBurnExecutor,
  type BurnWalletClient,
} from "../src/burn/executor";
import type { BurnConfig, BurnWindow } from "../src/burn/types";
import { db } from "../src/db";
import { burnEpochs, creditLots, ledgerEntries, runs } from "../src/db/schema";
import { newId } from "../src/lib/id";
import { usd8ToDecimalString } from "../src/onchain/credits";
import { findOrCreateProjectByWallet } from "../src/services/projects";

const WEEK_MS = 7 * 24 * 3_600_000;

function burnConfig(overrides: Partial<BurnConfig> = {}): BurnConfig {
  return {
    shareStable: 0.3,
    shareToken: 0.5,
    priceContext: { manualAllowed: true, gattaiUsdOverride: 1 },
    ...overrides,
  };
}

/** Jendela mingguan mulai dari tanggal UTC tertentu. */
function week(startIso: string): BurnWindow {
  const start = new Date(startIso);
  return { start, end: new Date(start.getTime() + WEEK_MS) };
}

// ── money ───────────────────────────────────────────────────────────────────

describe("burn money", () => {
  test("decimalToUsd8", () => {
    expect(decimalToUsd8("1.00000000")).toBe(100_000_000n);
    expect(decimalToUsd8("65.00000000")).toBe(6_500_000_000n);
    expect(decimalToUsd8("1.2")).toBe(120_000_000n);
    expect(decimalToUsd8("0")).toBe(0n);
    expect(decimalToUsd8("0.00000001")).toBe(1n);
  });

  test("shareUsd8 menerapkan porsi dengan pembulatan ke bawah", () => {
    expect(shareUsd8(3_500_000_000n, 0.3)).toBe(1_050_000_000n);
    expect(shareUsd8(1_400_000_000n, 0.5)).toBe(700_000_000n);
    expect(shareUsd8(0n, 0.5)).toBe(0n);
    expect(shareUsd8(100n, 0)).toBe(0n);
  });

  test("usd8ToTokens18 & bolak-balik", () => {
    expect(usd8ToTokens18(1_050_000_000n, 100_000_000n)).toBe(10_500_000_000_000_000_000n);
    expect(tokens18ToDecimalString(10_500_000_000_000_000_000n)).toBe("10.500000000000000000");
    expect(decimalToTokens18("10.5")).toBe(10_500_000_000_000_000_000n);
    expect(decimalToTokens18("0.000000000000000001")).toBe(1n);
  });
});

// ── windows ─────────────────────────────────────────────────────────────────

describe("burn windows", () => {
  test("alignDown membulatkan ke kelipatan durasi", () => {
    const day = 24 * 3_600_000;
    expect(alignDown(new Date("2026-09-03T07:30:00Z"), day).toISOString()).toBe(
      "2026-09-03T00:00:00.000Z",
    );
  });

  test("enumerateWindows dari genesis sampai now (jendela penuh saja)", () => {
    const windows = enumerateWindows(
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-15T12:00:00Z"),
      WEEK_MS,
    );
    expect(windows).toHaveLength(2);
    expect(windows[0].start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(windows[0].end.toISOString()).toBe("2026-09-08T00:00:00.000Z");
    expect(windows[1].end.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });
});

// ── perhitungan margin (murni) ───────────────────────────────────────────────

describe("planFromMarginRows", () => {
  test("satu lot ETH: margin × BURN_SHARE_STABLE", () => {
    const breakdown = planFromMarginRows({
      runs: [{ runId: "run_1", chargedMicro: 10_000_000_000, providerCostUsd: "65.00000000" }],
      settlements: [
        { runId: "run_1", lotId: "lot_eth", source: "ETH", consumedMicro: 10_000_000_000 },
      ],
      shareStable: 0.3,
      shareToken: 0.5,
      gattaiPrice8: 100_000_000n,
    });

    expect(breakdown.runs[0].marginUsd8).toBe(3_500_000_000n); // $35
    expect(breakdown.stableBudgetUsd8).toBe(1_050_000_000n); // 30% → $10,5
    expect(breakdown.tokenBudgetUsd8).toBe(0n);
    expect(breakdown.buybackTokens18).toBe(10_500_000_000_000_000_000n); // @ $1
    expect(usd8ToDecimalString(breakdown.totalBudgetUsd8)).toBe("10.50000000");
  });

  test("lot campuran ETH + GATTAI: diatribusikan proporsional (60/40)", () => {
    const breakdown = planFromMarginRows({
      runs: [{ runId: "run_1", chargedMicro: 10_000_000_000, providerCostUsd: "65.00000000" }],
      settlements: [
        { runId: "run_1", lotId: "lot_eth", source: "ETH", consumedMicro: 6_000_000_000 },
        { runId: "run_1", lotId: "lot_gattai", source: "GATTAI", consumedMicro: 4_000_000_000 },
      ],
      shareStable: 0.3,
      shareToken: 0.5,
      gattaiPrice8: 100_000_000n,
    });

    expect(breakdown.stableMarginUsd8).toBe(2_100_000_000n); // $21
    expect(breakdown.tokenMarginUsd8).toBe(1_400_000_000n); // $14
    expect(breakdown.stableBudgetUsd8).toBe(630_000_000n); // $6,3
    expect(breakdown.tokenBudgetUsd8).toBe(700_000_000n); // $7
    expect(breakdown.buybackTokens18).toBe(6_300_000_000_000_000_000n);
    expect(breakdown.directBurnTokens18).toBe(7_000_000_000_000_000_000n);
  });

  test("lot PROMO tidak menghasilkan margin burn", () => {
    const breakdown = planFromMarginRows({
      runs: [{ runId: "run_1", chargedMicro: 10_000_000_000, providerCostUsd: "0" }],
      settlements: [
        { runId: "run_1", lotId: "lot_promo", source: "PROMO", consumedMicro: 10_000_000_000 },
      ],
      shareStable: 0.3,
      shareToken: 0.5,
      gattaiPrice8: 100_000_000n,
    });

    expect(breakdown.stableMarginUsd8).toBe(0n);
    expect(breakdown.tokenMarginUsd8).toBe(0n);
    expect(breakdown.totalBudgetUsd8).toBe(0n);
  });

  test("margin negatif (provider > charged) dijepit ke 0", () => {
    const breakdown = planFromMarginRows({
      runs: [{ runId: "run_1", chargedMicro: 1_000_000_000, providerCostUsd: "20.00000000" }],
      settlements: [
        { runId: "run_1", lotId: "lot_eth", source: "ETH", consumedMicro: 1_000_000_000 },
      ],
      shareStable: 0.3,
      shareToken: 0.5,
      gattaiPrice8: 100_000_000n,
    });
    expect(breakdown.runs[0].marginUsd8).toBe(0n);
    expect(breakdown.totalBudgetUsd8).toBe(0n);
  });

  test("harga GATTAI null → budget tetap, token 0", () => {
    const breakdown = planFromMarginRows({
      runs: [{ runId: "run_1", chargedMicro: 10_000_000_000, providerCostUsd: "65.00000000" }],
      settlements: [
        { runId: "run_1", lotId: "lot_eth", source: "ETH", consumedMicro: 10_000_000_000 },
      ],
      shareStable: 0.3,
      shareToken: 0.5,
      gattaiPrice8: null,
    });
    expect(breakdown.totalBudgetUsd8).toBe(1_050_000_000n);
    expect(breakdown.buybackTokens18).toBe(0n);
  });
});

// ── executor ─────────────────────────────────────────────────────────────────

describe("burn executor", () => {
  const mixed = planFromMarginRows({
    runs: [{ runId: "run_1", chargedMicro: 10_000_000_000, providerCostUsd: "65.00000000" }],
    settlements: [
      { runId: "run_1", lotId: "lot_eth", source: "ETH", consumedMicro: 6_000_000_000 },
      { runId: "run_1", lotId: "lot_gattai", source: "GATTAI", consumedMicro: 4_000_000_000 },
    ],
    shareStable: 0.3,
    shareToken: 0.5,
    gattaiPrice8: 100_000_000n,
  });

  test("DryRunExecutor tidak mengirim transaksi", async () => {
    const result = await new DryRunExecutor().execute(mixed);
    expect(result).toEqual({ tokensBurned18: 0n, txHashes: [] });
  });

  test("OnchainBurnExecutor menolak buyback yang belum diimplementasikan", async () => {
    const executor = new OnchainBurnExecutor({
      wallet: { writeContract: async () => "0x00" },
      gattaiToken: "0x00000000000000000000000000000000000000a2",
      from: "0x00000000000000000000000000000000000000a3",
    });
    await expect(executor.execute(mixed)).rejects.toBeInstanceOf(BurnUnavailableError);
  });

  test("OnchainBurnExecutor memburn langsung saat tidak ada buyback", async () => {
    const calls: { functionName: string; args?: readonly unknown[] }[] = [];
    const wallet: BurnWalletClient = {
      writeContract: async (args) => {
        calls.push({ functionName: args.functionName, args: args.args });
        return "0xabc123";
      },
    };
    const executor = new OnchainBurnExecutor({
      wallet,
      gattaiToken: "0x00000000000000000000000000000000000000a2",
      from: "0x00000000000000000000000000000000000000a3",
    });

    const tokenOnly = planFromMarginRows({
      runs: [{ runId: "run_1", chargedMicro: 10_000_000_000, providerCostUsd: "65.00000000" }],
      settlements: [
        { runId: "run_1", lotId: "lot_gattai", source: "GATTAI", consumedMicro: 10_000_000_000 },
      ],
      shareStable: 0.3,
      shareToken: 0.5,
      gattaiPrice8: 100_000_000n,
    });

    const result = await executor.execute(tokenOnly);
    expect(result.tokensBurned18).toBe(17_500_000_000_000_000_000n); // $17,5 @ $1
    expect(result.txHashes).toEqual(["0xabc123"]);
    expect(calls[0].functionName).toBe("burn");
    expect(calls[0].args).toEqual([17_500_000_000_000_000_000n]);
  });
});

// ── integrasi DB ─────────────────────────────────────────────────────────────

async function freshProject() {
  const wallet = `0x${randomBytes(20).toString("hex")}`;
  return findOrCreateProjectByWallet(wallet);
}

async function seedRun(input: {
  projectId: string;
  finishedAt: Date;
  chargedMicro: number;
  providerCostUsd: string;
  lots: { source: "ETH" | "USDG" | "GATTAI" | "PROMO"; consumedMicro: number }[];
}): Promise<string> {
  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    projectId: input.projectId,
    recipeId: "test",
    recipeVersion: 1,
    status: "SETTLED",
    mode: "streaming",
    input: "test",
    reservedMicro: 0,
    chargedMicro: input.chargedMicro,
    providerCostUsd: input.providerCostUsd,
    idempotencyKey: `run:${runId}`,
    finishedAt: input.finishedAt,
  });

  for (const lot of input.lots) {
    const lotId = newId("lot");
    await db.insert(creditLots).values({
      id: lotId,
      projectId: input.projectId,
      source: lot.source,
      amountMicro: lot.consumedMicro,
      remainingMicro: 0,
    });
    await db.insert(ledgerEntries).values({
      id: newId("led"),
      projectId: input.projectId,
      runId,
      lotId,
      type: "SETTLE",
      amountMicro: -lot.consumedMicro,
      balanceAfterMicro: 0,
      idempotencyKey: `${runId}:settle:${lotId}`,
    });
  }
  return runId;
}

describe("burn epoch (DB)", () => {
  test("computeEpochPlan menggabungkan margin banyak run", async () => {
    const project = await freshProject();
    const w = week("2026-01-05T00:00:00Z");
    const finishedAt = new Date("2026-01-07T00:00:00Z");

    await seedRun({
      projectId: project.id,
      finishedAt,
      chargedMicro: 10_000_000_000, // $100
      providerCostUsd: "65.00000000",
      lots: [
        { source: "ETH", consumedMicro: 6_000_000_000 },
        { source: "GATTAI", consumedMicro: 4_000_000_000 },
      ],
    });
    await seedRun({
      projectId: project.id,
      finishedAt,
      chargedMicro: 5_000_000_000, // $50
      providerCostUsd: "40.00000000",
      lots: [{ source: "USDG", consumedMicro: 5_000_000_000 }],
    });

    const plan = await computeEpochPlan(w, burnConfig());
    expect(plan.runsCount).toBe(2);
    // ETH $21 + USDG $10 = $31 stable margin → 30% = $9,3
    expect(plan.breakdown.stableBudgetUsd8).toBe(930_000_000n);
    // GATTAI $14 margin → 50% = $7
    expect(plan.breakdown.tokenBudgetUsd8).toBe(700_000_000n);
    expect(plan.breakdown.totalBudgetUsd8).toBe(1_630_000_000n);
    expect(plan.priceSource).toBe("manual:GATTAI_USD_PRICE");
  });

  test("run di luar jendela tidak dihitung", async () => {
    const outside = await computeEpochPlan(week("2026-02-02T00:00:00Z"), burnConfig());
    expect(outside.runsCount).toBe(0);
    expect(outside.breakdown.totalBudgetUsd8).toBe(0n);
  });

  test("runBurnCycle dry-run mencatat epoch `pending` (idempotent)", async () => {
    const project = await freshProject();
    const w = week("2026-03-02T00:00:00Z");
    await seedRun({
      projectId: project.id,
      finishedAt: new Date("2026-03-04T00:00:00Z"),
      chargedMicro: 10_000_000_000,
      providerCostUsd: "65.00000000",
      lots: [{ source: "ETH", consumedMicro: 10_000_000_000 }],
    });

    const options = {
      executor: new DryRunExecutor(),
      config: burnConfig(),
      genesis: w.start,
      durationMs: WEEK_MS,
      window: w,
    };
    const first = await runBurnCycle(options);
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("pending");
    expect(first[0].tokensBurned18).toBe(0n);
    expect(first[0].totalBudgetUsd8).toBe(1_050_000_000n);
    expect(first[0].created).toBe(true);

    const second = await runBurnCycle(options);
    expect(second[0].epochId).toBe(first[0].epochId);
    expect(second[0].created).toBe(false);

    const row = await db.select().from(burnEpochs).where(eq(burnEpochs.id, first[0].epochId!));
    expect(row[0].status).toBe("pending");
    expect(row[0].budgetUsd).toBe("10.50000000");
    expect(row[0].txHashes).toEqual([]);
  });

  test("executor melaporkan 0 token → tetap pending, bukan executed", async () => {
    const project = await freshProject();
    const w = week("2026-03-09T00:00:00Z");
    await seedRun({
      projectId: project.id,
      finishedAt: new Date("2026-03-11T00:00:00Z"),
      chargedMicro: 10_000_000_000,
      providerCostUsd: "65.00000000",
      lots: [{ source: "ETH", consumedMicro: 10_000_000_000 }],
    });

    const [outcome] = await runBurnCycle({
      executor: {
        kind: "onchain",
        execute: async () => ({ tokensBurned18: 0n, txHashes: [] }),
      },
      config: burnConfig(),
      genesis: w.start,
      durationMs: WEEK_MS,
      window: w,
    });

    expect(outcome.status).toBe("pending");
    expect(outcome.tokensBurned18).toBe(0n);
    expect(outcome.executionError).toContain("0 token");
    const row = await db.select().from(burnEpochs).where(eq(burnEpochs.id, outcome.epochId!));
    expect(row[0]!.status).toBe("pending");
    expect(row[0]!.txHashes).toEqual([]);
  });

  test("epoch tanpa margin tidak dicatat", async () => {
    const w = week("2026-04-06T00:00:00Z");
    const outcomes = await runBurnCycle({
      executor: new DryRunExecutor(),
      config: burnConfig(),
      genesis: w.start,
      durationMs: WEEK_MS,
      window: w,
    });
    expect(outcomes[0].skipped).toBe(true);
  });

  test("markEpochExecuted + total publik + tidak ditimpa", async () => {
    const project = await freshProject();
    const w = week("2026-05-04T00:00:00Z");
    await seedRun({
      projectId: project.id,
      finishedAt: new Date("2026-05-06T00:00:00Z"),
      chargedMicro: 10_000_000_000,
      providerCostUsd: "65.00000000",
      lots: [{ source: "GATTAI", consumedMicro: 10_000_000_000 }],
    });

    const options = {
      executor: new DryRunExecutor(),
      config: burnConfig(),
      genesis: w.start,
      durationMs: WEEK_MS,
      window: w,
    };
    const [outcome] = await runBurnCycle(options);
    const tokens = 1_750_000_000_000_000_000n; // $17,5 @ $1

    const ok = await markEpochExecuted({
      periodStart: w.start,
      txHashes: ["0xburn1", "0xburn2"],
      tokensBurned18: tokens,
    });
    expect(ok).toBe(true);

    // record ulang tidak menimpa epoch yang sudah executed
    const again = await recordEpoch({
      window: w,
      breakdown: (await computeEpochPlan(w, burnConfig())).breakdown,
      status: "pending",
      tokensBurned18: 0n,
      txHashes: [],
      priceSource: null,
      priceError: null,
      mode: "dry-run",
      runsCount: 1,
    });
    expect(again.status).toBe("executed");
    expect(again.created).toBe(false);

    const row = await db.select().from(burnEpochs).where(eq(burnEpochs.id, outcome.epochId!));
    expect(row[0].status).toBe("executed");
    expect(row[0].txHashes).toEqual(["0xburn1", "0xburn2"]);
    expect(row[0].tokensBurned).toBe("1.750000000000000000");

    expect(await burnedTotalTokens()).toBe("1.750000000000000000");
  });

  test("GET /v1/public/burns mengembalikan total & epoch", async () => {
    const res = await app.request("/v1/public/burns");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total_tokens_burned: string;
      epochs: { status: string }[];
    };
    expect(typeof body.total_tokens_burned).toBe("string");
    expect(Array.isArray(body.epochs)).toBe(true);
    expect(body.epochs.some((epoch) => epoch.status === "executed")).toBe(true);
  });

  test("recordEpoch konkuren di window baru → satu baris, tanpa crash", async () => {
    const w = week("2026-08-03T00:00:00Z");
    const input = {
      window: w,
      breakdown: (await computeEpochPlan(w, burnConfig())).breakdown,
      status: "pending" as const,
      tokensBurned18: 0n,
      txHashes: [] as string[],
      priceSource: null,
      priceError: null,
      mode: "dry-run",
      runsCount: 0,
    };

    const results = await Promise.all(
      Array.from({ length: 6 }, () => recordEpoch({ ...input })),
    );
    const ids = new Set(results.map((result) => result.id));
    expect(ids.size).toBe(1);

    const rows = await db
      .select({ id: burnEpochs.id })
      .from(burnEpochs)
      .where(eq(burnEpochs.periodStart, w.start));
    expect(rows).toHaveLength(1);
  });
});
