import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { getBalanceMicro, listLots } from "../src/billing/ledger";
import { getParams } from "../src/config";
import { db } from "../src/db";
import { apiKeys, depositDeadLetters, deposits } from "../src/db/schema";
import { generateApiKey, hashSecret } from "../src/lib/crypto";
import { newId } from "../src/lib/id";
import {
  computeCreditsMicro,
  usd8ToDecimalString,
  usdValue8,
} from "../src/onchain/credits";
import { ingestDeposit, type IngestConfig } from "../src/onchain/ingest";
import { createDepositIndexer } from "../src/onchain/indexer";
import { retryPendingDeposits } from "../src/onchain/pending";
import { PriceUnavailableError, priceForToken, type PriceContext } from "../src/onchain/prices";
import { onchainProjectId } from "../src/onchain/project-id";
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
  const priceContext: PriceContext = {
    manualAllowed: true,
    ethUsdOverride: 3000,
    gattaiUsdOverride: 1,
  };
  return {
    tokens: registry,
    priceContext,
    capUsd: 1000,
    discountRatio: 0.15,
    confirmations: 3,
    ...overrides,
  };
}

async function freshProject() {
  const wallet = `0x${randomBytes(20).toString("hex")}`;
  const project = await findOrCreateProjectByWallet(wallet);
  return { project, onchainId: project.onchainId as string };
}

// ── credits ─────────────────────────────────────────────────────────────────

describe("onchain credits", () => {
  test("USDG 1:1: 1 USDG ($1) → 100 credits", () => {
    const usd8 = usdValue8(1_000_000n, 100_000_000n, 6);
    expect(usd8).toBe(100_000_000n);
    expect(computeCreditsMicro(usd8)).toBe(100_000_000n); // 100 credits
  });

  test("ETH: 1 ETH @ $3000 → $3000 credits (tanpa diskon)", () => {
    const usd8 = usdValue8(10n ** 18n, 300_000_000_000n, 18);
    expect(usd8).toBe(300_000_000_000n);
    expect(computeCreditsMicro(usd8)).toBe(300_000_000_000n);
  });

  test("diskon GATTAI: $85 → $100 credits", () => {
    const usd8 = 85n * 100_000_000n;
    expect(computeCreditsMicro(usd8, 0.15)).toBe(100n * 100_000_000n);
  });

  test("usd8ToDecimalString menghasilkan 8 desimal", () => {
    expect(usd8ToDecimalString(100_000_000n)).toBe("1.00000000");
    expect(usd8ToDecimalString(123_456_789n)).toBe("1.23456789");
    expect(usd8ToDecimalString(0n)).toBe("0.00000000");
  });
});

// ── project id ──────────────────────────────────────────────────────────────

describe("onchain project id", () => {
  test("keccak256 deterministik, bytes32 hex", () => {
    const id = onchainProjectId("prj_abc");
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(onchainProjectId("prj_abc")).toBe(id);
    expect(onchainProjectId("prj_xyz")).not.toBe(id);
  });
});

// ── prices ──────────────────────────────────────────────────────────────────

describe("onchain prices", () => {
  test("USDG selalu 1:1", async () => {
    const result = await priceForToken(registry.byAddress(USDG)!, { manualAllowed: false });
    expect(result.price8).toBe(100_000_000n);
    expect(result.source).toBe("usdg:1:1");
  });

  test("fail-closed: ETH tanpa feed & tanpa override", async () => {
    const spec = registry.byAddress(NATIVE_TOKEN)!;
    await expect(
      priceForToken(spec, { manualAllowed: false }),
    ).rejects.toBeInstanceOf(PriceUnavailableError);
  });

  test("harga manual hanya berlaku bila manualAllowed", async () => {
    const spec = registry.byAddress(NATIVE_TOKEN)!;
    const allowed = await priceForToken(spec, { manualAllowed: true, ethUsdOverride: 2500 });
    expect(allowed.price8).toBe(250_000_000_000n);
    expect(allowed.source).toBe("manual:ETH_USD_PRICE");

    await expect(
      priceForToken(spec, { manualAllowed: false, ethUsdOverride: 2500 }),
    ).rejects.toBeInstanceOf(PriceUnavailableError);
  });

  test("Chainlink: membaca feed & menormalkan ke 8 desimal", async () => {
    const reader = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "decimals") return 8;
        const now = BigInt(Math.floor(Date.now() / 1000));
        return [1n, 3_000_000_000_00n, now, now, 1n] as const;
      },
    };
    const spec = registry.byAddress(NATIVE_TOKEN)!;
    const result = await priceForToken(spec, {
      manualAllowed: false,
      reader,
      ethFeedAddress: "0x00000000000000000000000000000000000000f1",
    });
    expect(result.price8).toBe(3_000_000_000_00n);
    expect(result.source.startsWith("chainlink:")).toBe(true);
  });

  test("Chainlink: feed kedaluwarsa ditolak", async () => {
    const reader = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "decimals") return 8;
        return [1n, 3_000_000_000_00n, 0n, 1n, 1n] as const; // updatedAt sangat lama
      },
    };
    const spec = registry.byAddress(NATIVE_TOKEN)!;
    await expect(
      priceForToken(spec, {
        manualAllowed: false,
        reader,
        ethFeedAddress: "0x00000000000000000000000000000000000000f1",
      }),
    ).rejects.toBeInstanceOf(PriceUnavailableError);
  });

  test("GATTAI tanpa TWAP & tanpa override → fail-closed", async () => {
    const spec = registry.byAddress(GATTAI)!;
    await expect(
      priceForToken(spec, { manualAllowed: false }),
    ).rejects.toBeInstanceOf(PriceUnavailableError);
  });
});

// ── ingest (DB) ─────────────────────────────────────────────────────────────

describe("onchain ingest", () => {
  test("ETH yang valid dikreditkan + lot dibuat + sinkron ledger", async () => {
    const { project, onchainId } = await freshProject();
    const tx = `0x${newId("tx").replace(/\W/g, "")}`;

    const outcome = await ingestDeposit(
      {
        chainTx: tx,
        logIndex: 0,
        projectId: onchainId,
        payer: "0x1111111111111111111111111111111111111111",
        token: NATIVE_TOKEN,
        amountRaw: 10n ** 17n, // 0,1 ETH @ $3000 = $300
      },
      config(),
    );

    expect(outcome.status).toBe("credited");
    if (outcome.status !== "credited") return;
    expect(outcome.creditsMicro).toBe(30_000_000_000); // $300 = 30000 credits
    expect(await getBalanceMicro(project.id)).toBe(30_000_000_000);

    const lots = await listLots(project.id);
    expect(lots).toHaveLength(1);
    expect(lots[0].source).toBe("ETH");
    expect(lots[0].depositTx).toBe(tx);

    const row = await db.select().from(deposits).where(eq(deposits.id, outcome.depositId));
    expect(row[0].status).toBe("confirmed");
    expect(row[0].usdValue).toBe("300.00000000");
  });

  test("event sama diproses ulang → duplicate (idempotent)", async () => {
    const { onchainId } = await freshProject();
    const tx = `0x${newId("tx").replace(/\W/g, "")}`;
    const event = {
      chainTx: tx,
      logIndex: 1,
      projectId: onchainId,
      payer: NATIVE_TOKEN,
      token: NATIVE_TOKEN,
      amountRaw: 10n ** 17n,
    };

    const first = await ingestDeposit(event, config());
    expect(first.status).toBe("credited");

    const second = await ingestDeposit(event, config());
    expect(second.status).toBe("duplicate");
  });

  test("dua pemrosesan konkuren event sama → hanya satu kredit", async () => {
    const { project, onchainId } = await freshProject();
    const event = {
      chainTx: `0x${newId("tx").replace(/\W/g, "")}`,
      logIndex: 2,
      projectId: onchainId,
      payer: NATIVE_TOKEN,
      token: NATIVE_TOKEN,
      amountRaw: 10n ** 17n,
    };

    const outcomes = await Promise.all([
      ingestDeposit(event, config()),
      ingestDeposit(event, config()),
      ingestDeposit(event, config()),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "credited")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "duplicate")).toHaveLength(2);
    expect(await getBalanceMicro(project.id)).toBe(30_000_000_000);
    expect(await listLots(project.id)).toHaveLength(1);
  });

  test("projectId tidak dikenal → unknown_project + dead-letter", async () => {
    const chainTx = `0x${newId("tx").replace(/\W/g, "")}`;
    const outcome = await ingestDeposit(
      {
        chainTx,
        logIndex: 0,
        projectId: onchainProjectId("prj_tidak_ada"),
        payer: NATIVE_TOKEN,
        token: NATIVE_TOKEN,
        amountRaw: 10n ** 18n,
      },
      config(),
    );
    expect(outcome.status).toBe("unknown_project");

    const dlq = await db
      .select()
      .from(depositDeadLetters)
      .where(eq(depositDeadLetters.chainTx, chainTx));
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.error).toBe("unknown_project");
    expect(dlq[0]!.amountRaw).toBe((10n ** 18n).toString());
  });

  test("token tidak dikenal → unknown_token + needs_review", async () => {
    const { onchainId } = await freshProject();
    const chainTx = `0x${newId("tx").replace(/\W/g, "")}`;
    const outcome = await ingestDeposit(
      {
        chainTx,
        logIndex: 0,
        projectId: onchainId,
        payer: NATIVE_TOKEN,
        token: "0x00000000000000000000000000000000000000ff",
        amountRaw: 1n,
      },
      config(),
    );
    expect(outcome.status).toBe("unknown_token");

    const row = await db.select().from(deposits).where(eq(deposits.chainTx, chainTx));
    expect(row[0]!.status).toBe("needs_review");
  });

  test("melebihi cap → over_cap tanpa lot", async () => {
    const { project, onchainId } = await freshProject();
    const outcome = await ingestDeposit(
      {
        chainTx: `0x${newId("tx").replace(/\W/g, "")}`,
        logIndex: 0,
        projectId: onchainId,
        payer: NATIVE_TOKEN,
        token: NATIVE_TOKEN,
        amountRaw: 10n ** 18n, // $3000 > cap $1000
      },
      config({ capUsd: 1000 }),
    );
    expect(outcome.status).toBe("over_cap");
    expect(await getBalanceMicro(project.id)).toBe(0);
  });

  test("harga tidak tersedia → unpriced (tetap pending, tanpa lot)", async () => {
    const { project, onchainId } = await freshProject();
    const outcome = await ingestDeposit(
      {
        chainTx: `0x${newId("tx").replace(/\W/g, "")}`,
        logIndex: 0,
        projectId: onchainId,
        payer: NATIVE_TOKEN,
        token: NATIVE_TOKEN,
        amountRaw: 10n ** 18n,
      },
      config({ priceContext: { manualAllowed: false } }),
    );
    expect(outcome.status).toBe("unpriced");
    expect(await getBalanceMicro(project.id)).toBe(0);
  });

  test("deposit GATTAI memakai diskon 15%", async () => {
    const { project, onchainId } = await freshProject();
    const outcome = await ingestDeposit(
      {
        chainTx: `0x${newId("tx").replace(/\W/g, "")}`,
        logIndex: 0,
        projectId: onchainId,
        payer: GATTAI,
        token: GATTAI,
        amountRaw: 85n * 10n ** 18n, // 85 GATTAI @ $1 = $85
      },
      config({ capUsd: 0 }),
    );

    expect(outcome.status).toBe("credited");
    if (outcome.status !== "credited") return;
    expect(outcome.creditsMicro).toBe(100 * 100_000_000); // $100 credits
    expect(await getBalanceMicro(project.id)).toBe(100_000_000_00);

    const lots = await listLots(project.id);
    expect(lots[0].source).toBe("GATTAI");
  });

  test("retry pending mengkredit deposit yang tertinggal", async () => {
    const { project } = await freshProject();
    const tx = `0x${newId("tx").replace(/\W/g, "")}`;
    await db.insert(deposits).values({
      id: newId("dep"),
      projectId: project.id,
      chainTx: tx,
      logIndex: 0,
      token: USDG.toLowerCase(),
      payer: USDG.toLowerCase(),
      source: "USDG",
      amountRaw: "1000000",
      blockNumber: 700,
      blockHash: `0x${"11".repeat(32)}`,
      status: "pending",
      createdAt: new Date(Date.now() - 120_000),
    });

    const result = await retryPendingDeposits({
      config: config(),
      projectId: project.id,
      olderThanMs: 0,
      limit: 10,
    });
    expect(result.credited).toBe(1);

    const row = (await db.select().from(deposits).where(eq(deposits.chainTx, tx)))[0];
    expect(row.status).toBe("confirmed");
    expect(row.lotId).not.toBeNull();
    expect(await getBalanceMicro(project.id)).toBe(100_000_000);
  });

  test("retry pending membiarkan deposit tanpa harga tetap pending", async () => {
    const { project } = await freshProject();
    const tx = `0x${newId("tx").replace(/\W/g, "")}`;
    await db.insert(deposits).values({
      id: newId("dep"),
      projectId: project.id,
      chainTx: tx,
      logIndex: 0,
      token: NATIVE_TOKEN.toLowerCase(),
      payer: NATIVE_TOKEN.toLowerCase(),
      source: "ETH",
      amountRaw: (10n ** 18n).toString(),
      blockNumber: 701,
      blockHash: `0x${"22".repeat(32)}`,
      status: "pending",
      createdAt: new Date(Date.now() - 120_000),
    });

    const result = await retryPendingDeposits({
      config: config({ priceContext: { manualAllowed: false } }),
      projectId: project.id,
      olderThanMs: 0,
      limit: 10,
    });
    expect(result.stillPending).toBe(1);
    const row = (await db.select().from(deposits).where(eq(deposits.chainTx, tx)))[0];
    expect(row.status).toBe("pending");
  });
});

// ── routes ──────────────────────────────────────────────────────────────────

describe("onchain routes", () => {
  test("GET /v1/public/deposits/config tanpa auth", async () => {
    const res = await app.request("/v1/public/deposits/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chain_id: number;
      tokens: { symbol: string }[];
      discount_ratio: number;
      cap_usd: number;
    };
    expect(typeof body.chain_id).toBe("number");
    // Aset yang tampil bergantung pada env (Fase 1: USDG-only). Jangan
    // mengunci test ke ETH; cukup pastikan endpoint mengembalikan daftar
    // token yang valid tanpa auth.
    expect(Array.isArray(body.tokens)).toBe(true);
    expect(body.tokens.length).toBeGreaterThan(0);
    expect(
      body.tokens.every((token) => typeof token.symbol === "string"),
    ).toBe(true);
    expect(body.discount_ratio).toBe(0.15);
    expect(body.cap_usd).toBe(getParams().deposits.cap_usd);
  });

  test("GET /v1/project mengekspos onchain_id", async () => {

    const project = await findOrCreateProjectByWallet(
      `0x${randomBytes(20).toString("hex")}`,
    );
    const generated = generateApiKey();
    await db.insert(apiKeys).values({
      id: newId("key"),
      projectId: project.id,
      prefix: generated.prefix,
      hash: hashSecret(generated.secret),
      label: "onchain-test",
    });

    const res = await app.request("/v1/project", {
      headers: { authorization: `Bearer ${generated.secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { onchain_id: string };
    expect(body.onchain_id).toBe(onchainProjectId(project.id));
  });
});

// ── indexer: kursor & retry ───────────────────────────────────────────────────

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
      projectId: onchainProjectId("prj_indexer"),
      payer: "0x1111111111111111111111111111111111111111",
      token: NATIVE_TOKEN,
      amount: 10n ** 17n,
    },
    transactionHash: tx,
    logIndex,
    blockNumber,
  };
}

const credited = { status: "credited", depositId: "dep_1", lotId: "lot_1", creditsMicro: 1, usdValue: "0.00000001" } as const;

describe("indexer cursor", () => {
  test("log gagal infra menahan kursor; tick berikut mengulang dan maju", async () => {
    const logA = fakeLog(90n, 0, "0xaaa");
    const logB = fakeLog(91n, 0, "0xbbb");
    const logC = fakeLog(92n, 0, "0xccc");
    const flaky = new Set<string>();
    const seen = new Set<string>();
    const errors: unknown[] = [];

    const indexer = createDepositIndexer({
      ...config(),
      client: fakeClient([logA, logB, logC]),
      depositManager: "0x00000000000000000000000000000000000000d1",
      fromBlock: 90n,
      batchBlocks: 100,
      pollIntervalMs: 1000,
      ingest: async (event) => {
        const key = `${event.chainTx}:${event.logIndex}`;
        if (event.chainTx === "0xbbb" && !flaky.has(key)) {
          flaky.add(key);
          throw new Error("DB sempat down");
        }
        if (seen.has(key)) return { status: "duplicate", depositId: "dep_1" };
        seen.add(key);
        return { ...credited };
      },
      onError: (error) => errors.push(error),
    });

    const first = await indexer.tick();
    expect(first.processed).toBe(2);
    expect(first.failed).toBe(1);
    expect(indexer.cursor()).toBe(91n);
    expect(errors).toHaveLength(1);

    const second = await indexer.tick();
    expect(second.processed).toBe(1);
    expect(second.failed).toBe(0);
    expect(indexer.cursor()).toBe(98n);
  });

  test("log beracun dilewati setelah ambang dengan laporan, kursor tidak macet", async () => {
    const logD = fakeLog(90n, 0, "0xddd");
    const errors: unknown[] = [];

    const indexer = createDepositIndexer({
      ...config(),
      client: fakeClient([logD]),
      depositManager: "0x00000000000000000000000000000000000000d1",
      fromBlock: 90n,
      batchBlocks: 100,
      pollIntervalMs: 1000,
      ingest: async () => {
        throw new Error("selalu gagal");
      },
      onError: (error) => errors.push(error),
    });

    for (let i = 0; i < 11; i++) {
      await indexer.tick();
    }
    expect(indexer.cursor()).toBe(98n);
    expect(errors.some((error) => String(error).includes("melewati log"))).toBe(true);
  });
});
