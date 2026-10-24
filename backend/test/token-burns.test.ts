import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { PublicClient } from "viem";
import app from "../src/app";
import { createBurnIndexer, TRANSFER_EVENT } from "../src/burn/indexer";
import {
  burnedPercent,
  classifyTokenBurn,
  formatTokenAmount,
  getTokenBurnStats,
  ingestTokenBurn,
  loadEpochBurnTxHashes,
} from "../src/burn/token-burns";
import { db } from "../src/db";
import { burnEpochs, tokenBurns } from "../src/db/schema";
import { newId } from "../src/lib/id";

const TOKEN = "0x863019e2e676164fcfaab6e14dcd6568eb6deb1f";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const TEAM = "0xca39f6f2aff53659e072da95537ba2f818a6890a";
const OTHER = "0x1111111111111111111111111111111111111111";

const T20M = 20_000_000_000_000_000_000_000_000n;
const T8M = 8_061_822_210_522_966_378_459_998n;
const T1M = 1_000_000_000_000_000_000_000_000n;
const T5M = 5_000_000_000_000_000_000_000_000n;

function randomTx(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

function event(overrides: {
  chainTx: string;
  logIndex: number;
  from: string;
  amountRaw: bigint;
  blockNumber?: bigint;
}) {
  return {
    chainTx: overrides.chainTx,
    logIndex: overrides.logIndex,
    tokenAddress: TOKEN,
    from: overrides.from,
    to: DEAD,
    amountRaw: overrides.amountRaw,
    decimals: 18,
    blockNumber: overrides.blockNumber ?? 96_200_000n,
    blockHash: randomTx(),
    blockTimestamp: new Date("2026-10-23T19:26:10Z"),
  };
}

describe("burn classification & formatting", () => {
  test("epoch > team > community", () => {
    const teamWallets = new Set([TEAM]);
    const epochByTx = new Map([["0xabc", "epoch_1"]]);

    expect(classifyTokenBurn(TEAM, "0xabc", { teamWallets, epochByTx })).toEqual({
      kind: "epoch",
      epochId: "epoch_1",
    });
    expect(classifyTokenBurn(TEAM, "0xdef", { teamWallets, epochByTx })).toEqual({
      kind: "team",
      epochId: null,
    });
    expect(classifyTokenBurn(OTHER, "0xdef", { teamWallets, epochByTx })).toEqual({
      kind: "community",
      epochId: null,
    });
  });

  test("format exact: 28,061,822.210522966378459998", () => {
    expect(formatTokenAmount(T20M + T8M, 18)).toBe("28061822.210522966378459998");
    expect(formatTokenAmount(T8M, 18)).toBe("8061822.210522966378459998");
  });

  test("persentase supply integer-only", () => {
    const supply = 1_000_000_000n * 10n ** 18n;
    expect(burnedPercent(T20M + T8M, supply)).toBe("2.80618222");
    expect(burnedPercent(0n, supply)).toBe("0.00000000");
    expect(burnedPercent(T1M, 0n)).toBe("0.00000000");
  });
});

describe("token burns (DB)", () => {
  test("ingest idempotent + klasifikasi + total exact", async () => {
    const teamTx = randomTx();
    const communityTx = randomTx();
    const epochTx = randomTx();
    const periodStart = new Date("2099-01-01T00:00:00.000Z");
    const epochId = newId("epoch");

    await db.insert(burnEpochs).values({
      id: epochId,
      periodStart,
      periodEnd: new Date("2099-01-08T00:00:00.000Z"),
      budgetUsd: "0.00000000",
      tokensBurned: "0.000000000000000000",
      txHashes: [epochTx],
      status: "executed",
    });

    const epochByTx = await loadEpochBurnTxHashes();
    expect(epochByTx.get(epochTx)).toBe(epochId);

    const options = { teamWallets: new Set([TEAM]), epochByTx };

    await ingestTokenBurn(event({ chainTx: teamTx, logIndex: 0, from: TEAM, amountRaw: T20M }), options);
    await ingestTokenBurn(
      event({ chainTx: communityTx, logIndex: 1, from: OTHER, amountRaw: T5M }),
      options,
    );
    await ingestTokenBurn(event({ chainTx: epochTx, logIndex: 2, from: TEAM, amountRaw: T1M }), options);
    // Replay log pertama: tidak boleh menggandakan baris.
    await ingestTokenBurn(event({ chainTx: teamTx, logIndex: 0, from: TEAM, amountRaw: T20M }), options);

    const rows = await db
      .select()
      .from(tokenBurns)
      .where(inArray(tokenBurns.chainTx, [teamTx, communityTx, epochTx]));

    expect(rows).toHaveLength(3);
    const byTx = new Map(rows.map((row) => [row.chainTx, row]));
    expect(byTx.get(teamTx)?.kind).toBe("team");
    expect(byTx.get(communityTx)?.kind).toBe("community");
    expect(byTx.get(epochTx)?.kind).toBe("epoch");
    expect(byTx.get(epochTx)?.epochId).toBe(epochId);
    expect(byTx.get(teamTx)?.amountRaw).toBe(T20M.toString());
    expect(byTx.get(teamTx)?.toAddress).toBe(DEAD.toLowerCase());

    const sum = rows.reduce((total, row) => total + BigInt(row.amountRaw), 0n);
    expect(sum).toBe(T20M + T5M + T1M);

    const stats = await getTokenBurnStats();
    expect(stats.totalRaw).toBeGreaterThanOrEqual(sum);
    expect(stats.teamRaw).toBeGreaterThanOrEqual(T20M);
    expect(stats.epochRaw).toBeGreaterThanOrEqual(T1M);
    expect(stats.communityRaw).toBeGreaterThanOrEqual(T5M);
  });

  test("GET /v1/public/burns mengirim base-unit exact + metadata token", async () => {
    const tx = randomTx();
    await ingestTokenBurn(event({ chainTx: tx, logIndex: 9, from: TEAM, amountRaw: T8M }), {
      teamWallets: new Set([TEAM]),
      epochByTx: new Map(),
    });

    const res = await app.request("/v1/public/burns");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=30");

    const body = (await res.json()) as {
      token: { decimals: number; total_supply_raw: string; symbol: string };
      total_tokens_burned_raw: string;
      burns: {
        tx_hash: string;
        amount_raw: string;
        amount: string;
        kind: string;
        decimals: number;
      }[];
    };

    expect(body.token.decimals).toBe(18);
    expect(body.token.symbol).toBe("GATTAI");
    expect(body.token.total_supply_raw).toBe((1_000_000_000n * 10n ** 18n).toString());
    expect(typeof body.total_tokens_burned_raw).toBe("string");

    const row = body.burns.find((burn) => burn.tx_hash === tx);
    expect(row).toBeDefined();
    expect(row?.kind).toBe("team");
    expect(row?.amount_raw).toBe(T8M.toString());
    expect(row?.amount).toBe("8061822.210522966378459998");
    expect(row?.decimals).toBe(18);
  });
});

describe("burn indexer", () => {
  test("hanya Transfer ke dead address yang diproses + kursor maju", async () => {
    const deadTx = randomTx();
    const otherTx = randomTx();
    const ignoredTx = randomTx();
    const events: string[] = [];
    const cursors: bigint[] = [];

    const client = {
      getBlockNumber: async () => 1000n,
      getBlock: async () => ({ hash: randomTx(), timestamp: 1_700_000_000n }),
      getLogs: async () => [
        {
          args: { from: TEAM, to: DEAD, value: T20M },
          transactionHash: deadTx,
          logIndex: 0,
          blockNumber: 985n,
          blockHash: randomTx(),
        },
        {
          args: { from: TEAM, to: OTHER, value: T5M },
          transactionHash: otherTx,
          logIndex: 1,
          blockNumber: 986n,
          blockHash: randomTx(),
        },
        {
          args: { from: OTHER, to: DEAD.toLowerCase(), value: T1M },
          transactionHash: ignoredTx,
          logIndex: 2,
          blockNumber: 987n,
          blockHash: randomTx(),
        },
      ],
    } as unknown as PublicClient;

    const indexer = createBurnIndexer({
      client,
      tokenAddress: TOKEN as `0x${string}`,
      decimals: 18,
      fromBlock: 980n,
      batchBlocks: 100,
      pollIntervalMs: 1000,
      confirmations: 10,
      deadAddresses: new Set([DEAD.toLowerCase()]),
      teamWallets: new Set([TEAM]),
      lookbackBlocks: 0n,
      loadEpochs: async () => new Map(),
      ingest: async (burnEvent) => {
        events.push(burnEvent.chainTx);
      },
      persistCursor: (cursor) => {
        cursors.push(cursor);
      },
      onError: () => {},
    });

    const result = await indexer.tick();
    expect(result.processed).toBe(2);
    expect(result.toBlock).toBe(990n);
    expect(indexer.cursor()).toBe(991n);
    expect(events).toEqual([deadTx, ignoredTx]);
    expect(cursors).toEqual([991n]);
    expect(TRANSFER_EVENT.name).toBe("Transfer");
  });

  test("reorg menghapus burn dan memundurkan kursor", async () => {
    const tx = randomTx();
    const oldHash = randomTx();
    const newHash = randomTx();

    const cursors: bigint[] = [];
    const client = {
      getBlockNumber: async () => 1000n,
      getBlock: async () => ({ hash: newHash, timestamp: 1_700_000_000n }),
      getLogs: async () => [],
    } as unknown as PublicClient;

    const indexer = createBurnIndexer({
      client,
      tokenAddress: TOKEN as `0x${string}`,
      decimals: 18,
      fromBlock: 900n,
      batchBlocks: 100,
      pollIntervalMs: 1000,
      confirmations: 10,
      deadAddresses: new Set([DEAD.toLowerCase()]),
      teamWallets: new Set([TEAM]),
      lookbackBlocks: 20n,
      loadEpochs: async () => new Map(),
      ingest: async () => {},
      persistCursor: (cursor) => {
        cursors.push(cursor);
      },
      onError: () => {},
    });

    // Tick pertama memajukan kursor ke 991 (di atas blok reorg 985).
    await indexer.tick();
    expect(indexer.cursor()).toBe(991n);

    await db.insert(tokenBurns).values({
      id: newId("burn"),
      chainTx: tx,
      logIndex: 0,
      tokenAddress: TOKEN,
      fromAddress: TEAM,
      toAddress: DEAD.toLowerCase(),
      amountRaw: T20M.toString(),
      decimals: 18,
      blockNumber: 985,
      blockHash: oldHash,
      blockTimestamp: new Date("2026-10-23T19:26:10Z"),
      kind: "team",
      epochId: null,
    });

    const result = await indexer.tick();
    expect(result.processed).toBe(0);
    expect(cursors).toContain(985n);

    const rows = await db.select().from(tokenBurns).where(eq(tokenBurns.chainTx, tx));
    expect(rows).toHaveLength(0);
  });
});
