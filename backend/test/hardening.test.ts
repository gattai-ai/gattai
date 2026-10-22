import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { createSessionToken } from "../src/auth/session";
import { getBalanceMicro, recordCreditLot, reverseCredit } from "../src/billing/ledger";
import { db } from "../src/db";
import { depositDeadLetters, deposits } from "../src/db/schema";
import { newId } from "../src/lib/id";
import { ingestDeposit, type IngestConfig, type IngestOutcome } from "../src/onchain/ingest";
import { createDepositIndexer } from "../src/onchain/indexer";
import { reconcileReorgs, type ReorgDeps } from "../src/onchain/reorg";
import { buildTokenRegistry } from "../src/onchain/registry";
import { NATIVE_TOKEN, type Hex } from "../src/onchain/types";
import { findOrCreateProjectByWallet } from "../src/services/projects";

const USDG: Hex = "0x00000000000000000000000000000000000000a1";
const GATTAI: Hex = "0x00000000000000000000000000000000000000a2";

const registry = buildTokenRegistry({
  gattaiTokenAddress: GATTAI,
  usdgTokenAddress: USDG,
  usdgDecimals: 6,
});

function config(overrides: Partial<IngestConfig> = {}): IngestConfig {
  return {
    tokens: registry,
    priceContext: { manualAllowed: true, ethUsdOverride: 3000, gattaiUsdOverride: 1 },
    capUsd: 1000,
    discountRatio: 0.15,
    confirmations: 1,
    ...overrides,
  };
}

async function freshProject() {
  return findOrCreateProjectByWallet(`0x${randomBytes(20).toString("hex")}`);
}

function txHash(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

// ── anti-dust (P2.1) ─────────────────────────────────────────────────────────

describe("anti-dust deposit", () => {
  test("di bawah ambang → tidak dikreditkan, status dust", async () => {
    const project = await freshProject();
    const outcome = await ingestDeposit(
      {
        chainTx: txHash(),
        logIndex: 0,
        projectId: project.onchainId as string,
        payer: NATIVE_TOKEN,
        token: NATIVE_TOKEN,
        amountRaw: 10n ** 15n, // 0.001 ETH = $3
      },
      config({ minUsd: 10 }),
    );
    expect(outcome.status).toBe("dust");
    expect(await getBalanceMicro(project.id)).toBe(0);

    const rows = await db.select().from(deposits).where(eq(deposits.projectId, project.id));
    expect(rows.some((row) => row.status === "dust")).toBe(true);
  });

  test("di atas ambang → tetap dikreditkan", async () => {
    const project = await freshProject();
    const outcome = await ingestDeposit(
      {
        chainTx: txHash(),
        logIndex: 0,
        projectId: project.onchainId as string,
        payer: NATIVE_TOKEN,
        token: NATIVE_TOKEN,
        amountRaw: 10n ** 15n, // $3 > ambang $1
      },
      config({ minUsd: 1 }),
    );
    expect(outcome.status).toBe("credited");
  });
});

// ── pembatalan kredit (P0.3, jalur manual) ───────────────────────────────────

describe("reverseCredit", () => {
  test("mengurangi saldo dan idempotent per idempotencyKey", async () => {
    const project = await freshProject();
    const { lotId } = await recordCreditLot({
      projectId: project.id,
      source: "ETH",
      amountMicro: 5_000_000,
      idempotencyKey: `test:${newId("k")}`,
    });
    expect(await getBalanceMicro(project.id)).toBe(5_000_000);

    const reverseKey = `reorg:test:${newId("k")}`;
    const first = await reverseCredit({
      projectId: project.id,
      lotId,
      amountMicro: 5_000_000,
      idempotencyKey: reverseKey,
    });
    expect(first.applied).toBe(true);
    expect(await getBalanceMicro(project.id)).toBe(0);

    const second = await reverseCredit({
      projectId: project.id,
      lotId,
      amountMicro: 5_000_000,
      idempotencyKey: reverseKey,
    });
    expect(second.applied).toBe(false);
    expect(await getBalanceMicro(project.id)).toBe(0);
  });
});

// ── indexer: persist kursor & dead-letter (P1.1, P0.2) ───────────────────────

interface FakeLog {
  args: { projectId: string; payer: string; token: string; amount: bigint };
  transactionHash: string;
  logIndex: number;
  blockNumber: bigint;
}

function fakeClient(logs: FakeLog[], head: bigint = 100n) {
  return {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
  } as unknown as import("viem").PublicClient;
}

function fakeLog(blockNumber: bigint, logIndex: number, tx: string): FakeLog {
  return {
    args: {
      projectId: `0x${"11".repeat(32)}`,
      payer: "0x1111111111111111111111111111111111111111",
      token: NATIVE_TOKEN,
      amount: 10n ** 17n,
    },
    transactionHash: tx,
    logIndex,
    blockNumber,
  };
}

const credited: IngestOutcome = {
  status: "credited",
  depositId: "dep_1",
  lotId: "lot_1",
  creditsMicro: 1,
  usdValue: "0.00000001",
};

describe("indexer hardening", () => {
  test("kursor dipersist setiap kali maju", async () => {
    const persisted: bigint[] = [];
    const indexer = createDepositIndexer({
      ...config({ confirmations: 3 }),
      client: fakeClient([fakeLog(90n, 0, "0xaaa")]),
      depositManager: "0x00000000000000000000000000000000000000d1",
      fromBlock: 90n,
      batchBlocks: 100,
      pollIntervalMs: 1000,
      ingest: async () => credited,
      persistCursor: (cursor) => {
        persisted.push(cursor);
      },
    });
    await indexer.tick();
    expect(persisted).toEqual([98n]);
  });

  test("kursor dipersist per batch (catch-up panjang bisa dilanjutkan)", async () => {
    const persisted: bigint[] = [];
    const indexer = createDepositIndexer({
      ...config({ confirmations: 3 }),
      client: fakeClient([]),
      depositManager: "0x00000000000000000000000000000000000000d1",
      fromBlock: 90n,
      batchBlocks: 5,
      pollIntervalMs: 1000,
      ingest: async () => credited,
      persistCursor: (cursor) => {
        persisted.push(cursor);
      },
    });
    await indexer.tick();
    expect(persisted).toEqual([95n, 98n]);
  });

  test("poison pill → onPoisonPill dipanggil lalu log dilewati", async () => {
    const pills: number[] = [];
    const indexer = createDepositIndexer({
      ...config({ confirmations: 3 }),
      client: fakeClient([fakeLog(90n, 0, "0xbbb")]),
      depositManager: "0x00000000000000000000000000000000000000d1",
      fromBlock: 90n,
      batchBlocks: 100,
      pollIntervalMs: 1000,
      ingest: async () => {
        throw new Error("selalu gagal");
      },
      onPoisonPill: (_event, _error, attempts) => {
        pills.push(attempts);
      },
      onError: () => {},
    });

    for (let i = 0; i < 11; i++) await indexer.tick();
    expect(pills).toEqual([11]);
    expect(indexer.cursor()).toBe(98n);
  });
});

// ── penjaga reorg (P0.3) ─────────────────────────────────────────────────────

describe("reorg guard", () => {
  test("inklusi ulang → referensi blok dirapikan, saldo tetap", async () => {
    const project = await freshProject();
    const { lotId } = await recordCreditLot({
      projectId: project.id,
      source: "ETH",
      amountMicro: 7_000_000,
      idempotencyKey: `test:${newId("k")}`,
    });
    const id = newId("dep");
    const tx = txHash();
    await db.insert(deposits).values({
      id,
      projectId: project.id,
      chainTx: tx,
      logIndex: 0,
      token: NATIVE_TOKEN,
      source: "ETH",
      amountRaw: "1",
      creditsMicro: 7_000_000,
      lotId,
      blockNumber: 100,
      blockHash: `0x${"aa".repeat(32)}`,
      confirmations: 1,
      status: "confirmed",
    });

    const client = {
      getTransactionReceipt: async () => ({
        blockNumber: 101n,
        blockHash: `0x${"bb".repeat(32)}`,
      }),
    } as unknown as ReorgDeps["client"];

    const result = await reconcileReorgs(1000n, {
      client,
      lookbackBlocks: 1000n,
      missCounts: new Map(),
    });
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(deposits).where(eq(deposits.id, id));
    expect(rows[0].status).toBe("confirmed");
    expect(rows[0].blockNumber).toBe(101);
    expect(rows[0].blockHash).toBe(`0x${"bb".repeat(32)}`);
    expect(await getBalanceMicro(project.id)).toBe(7_000_000);
  });

  test("baris confirmed dengan metadata NULL di-backfill", async () => {
    const project = await freshProject();
    const { lotId } = await recordCreditLot({
      projectId: project.id,
      source: "ETH",
      amountMicro: 7_000_000,
      idempotencyKey: `test:${newId("k")}`,
    });
    const id = newId("dep");
    const tx = txHash();
    await db.insert(deposits).values({
      id,
      projectId: project.id,
      chainTx: tx,
      logIndex: 0,
      token: NATIVE_TOKEN,
      source: "ETH",
      amountRaw: "1",
      creditsMicro: 7_000_000,
      lotId,
      blockNumber: null,
      blockHash: null,
      confirmations: 1,
      status: "confirmed",
    });

    const client = {
      getTransactionReceipt: async () => ({
        blockNumber: 600n,
        blockHash: `0x${"ab".repeat(32)}`,
      }),
    } as unknown as ReorgDeps["client"];

    const result = await reconcileReorgs(1000n, {
      client,
      lookbackBlocks: 1n,
      missCounts: new Map(),
    });
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    const row = (await db.select().from(deposits).where(eq(deposits.id, id)))[0];
    expect(row.blockNumber).toBe(600);
    expect(row.blockHash).toBe(`0x${"ab".repeat(32)}`);
    expect(await getBalanceMicro(project.id)).toBe(7_000_000);
  });

  test("tx hilang → reorged + dead-letter setelah ambang", async () => {
    const project = await freshProject();
    const id = newId("dep");
    const tx = txHash();
    await db.insert(deposits).values({
      id,
      projectId: project.id,
      chainTx: tx,
      logIndex: 1,
      token: NATIVE_TOKEN,
      source: "ETH",
      amountRaw: "1",
      creditsMicro: 0,
      blockNumber: 200,
      blockHash: `0x${"cc".repeat(32)}`,
      confirmations: 1,
      status: "confirmed",
    });

    const client = {
      getTransactionReceipt: async () => null,
    } as unknown as ReorgDeps["client"];
    const missCounts = new Map<string, number>();

    await reconcileReorgs(1000n, { client, lookbackBlocks: 1000n, missThreshold: 2, missCounts });
    expect((await db.select().from(deposits).where(eq(deposits.id, id)))[0].status).toBe("confirmed");

    await reconcileReorgs(1000n, { client, lookbackBlocks: 1000n, missThreshold: 2, missCounts });
    expect((await db.select().from(deposits).where(eq(deposits.id, id)))[0].status).toBe(
      "reorged",
    );

    const dead = await db
      .select()
      .from(depositDeadLetters)
      .where(eq(depositDeadLetters.chainTx, tx));
    expect(dead).toHaveLength(1);
  });

  test("tx hilang menarik kredit; tx muncul lagi memulihkan kredit", async () => {
    const project = await freshProject();
    const { lotId } = await recordCreditLot({
      projectId: project.id,
      source: "ETH",
      amountMicro: 7_000_000,
      idempotencyKey: `test:${newId("k")}`,
    });
    const id = newId("dep");
    const tx = txHash();
    await db.insert(deposits).values({
      id,
      projectId: project.id,
      chainTx: tx,
      logIndex: 4,
      token: NATIVE_TOKEN,
      source: "ETH",
      amountRaw: "1",
      creditsMicro: 7_000_000,
      lotId,
      blockNumber: 500,
      blockHash: `0x${"aa".repeat(32)}`,
      confirmations: 1,
      status: "confirmed",
    });

    const missing = {
      getTransactionReceipt: async () => null,
    } as unknown as ReorgDeps["client"];
    const missCounts = new Map<string, number>();
    await reconcileReorgs(1000n, { client: missing, lookbackBlocks: 1000n, missThreshold: 2, missCounts });
    await reconcileReorgs(1000n, { client: missing, lookbackBlocks: 1000n, missThreshold: 2, missCounts });

    expect((await db.select().from(deposits).where(eq(deposits.id, id)))[0].status).toBe("reorged");
    expect(await getBalanceMicro(project.id)).toBe(0);

    const reappeared = {
      getTransactionReceipt: async () => ({
        blockNumber: 501n,
        blockHash: `0x${"bb".repeat(32)}`,
      }),
    } as unknown as ReorgDeps["client"];
    const restored = await reconcileReorgs(1000n, {
      client: reappeared,
      lookbackBlocks: 1000n,
      missThreshold: 2,
      missCounts,
    });
    expect(restored.restored).toBeGreaterThanOrEqual(1);

    const row = (await db.select().from(deposits).where(eq(deposits.id, id)))[0];
    expect(row.status).toBe("confirmed");
    expect(row.blockNumber).toBe(501);
    expect(await getBalanceMicro(project.id)).toBe(7_000_000);

    // Siklus kedua: tx hilang lagi lalu muncul di block yang sama. Restore
    // harus tetap membuat kredit baru, bukan memakai lot lama yang sudah 0.
    await reconcileReorgs(1000n, { client: missing, lookbackBlocks: 1000n, missThreshold: 2, missCounts });
    await reconcileReorgs(1000n, { client: missing, lookbackBlocks: 1000n, missThreshold: 2, missCounts });
    expect((await db.select().from(deposits).where(eq(deposits.id, id)))[0].status).toBe(
      "reorged",
    );
    expect(await getBalanceMicro(project.id)).toBe(0);

    const restoredAgain = await reconcileReorgs(1000n, {
      client: reappeared,
      lookbackBlocks: 1000n,
      missThreshold: 2,
      missCounts,
    });
    expect(restoredAgain.restored).toBeGreaterThanOrEqual(1);
    expect(await getBalanceMicro(project.id)).toBe(7_000_000);
  });

  test("receipt-not-found dari viem dihitung sebagai miss", async () => {
    const project = await freshProject();
    const id = newId("dep");
    const tx = txHash();
    await db.insert(deposits).values({
      id,
      projectId: project.id,
      chainTx: tx,
      logIndex: 2,
      token: NATIVE_TOKEN,
      source: "ETH",
      amountRaw: "1",
      creditsMicro: 0,
      blockNumber: 300,
      blockHash: `0x${"dd".repeat(32)}`,
      confirmations: 1,
      status: "confirmed",
    });

    const notFound = Object.assign(
      new Error(`Transaction receipt with hash "${tx}" could not be found.`),
      { name: "TransactionReceiptNotFoundError" },
    );
    const client = {
      getTransactionReceipt: async () => {
        throw notFound;
      },
    } as unknown as ReorgDeps["client"];

    const missCounts = new Map<string, number>();
    await reconcileReorgs(1000n, { client, lookbackBlocks: 1000n, missThreshold: 2, missCounts });
    expect((await db.select().from(deposits).where(eq(deposits.id, id)))[0].status).toBe(
      "confirmed",
    );
    await reconcileReorgs(1000n, { client, lookbackBlocks: 1000n, missThreshold: 2, missCounts });
    expect((await db.select().from(deposits).where(eq(deposits.id, id)))[0].status).toBe(
      "reorged",
    );
  });

  test("gangguan RPC generik tidak pernah dihitung sebagai reorg", async () => {
    const project = await freshProject();
    const id = newId("dep");
    const tx = txHash();
    await db.insert(deposits).values({
      id,
      projectId: project.id,
      chainTx: tx,
      logIndex: 3,
      token: NATIVE_TOKEN,
      source: "ETH",
      amountRaw: "1",
      creditsMicro: 0,
      blockNumber: 400,
      blockHash: `0x${"ee".repeat(32)}`,
      confirmations: 1,
      status: "confirmed",
    });

    const client = {
      getTransactionReceipt: async () => {
        throw new Error("HTTP 503 Service Unavailable");
      },
    } as unknown as ReorgDeps["client"];

    const missCounts = new Map<string, number>();
    for (let i = 0; i < 3; i++) {
      await reconcileReorgs(1000n, {
        client,
        lookbackBlocks: 1000n,
        missThreshold: 1,
        missCounts,
      });
    }
    expect((await db.select().from(deposits).where(eq(deposits.id, id)))[0].status).toBe(
      "confirmed",
    );
  });
});

// ── sesi hantu (P2.3) ────────────────────────────────────────────────────────

describe("auth/me", () => {
  test("sesi menunjuk project tak ada → 401", async () => {
    const token = createSessionToken(
      "prj_tidak_ada",
      "0x1111111111111111111111111111111111111111",
      "ses_tidak_ada",
    );
    const res = await app.request("/auth/me", {
      headers: { cookie: `gattai_session=${token}` },
    });
    expect(res.status).toBe(401);
  });
});

