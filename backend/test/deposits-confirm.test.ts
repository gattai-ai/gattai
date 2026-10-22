import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import app from "../src/app";
import { db } from "../src/db";
import { apiKeys } from "../src/db/schema";
import { generateApiKey, hashSecret } from "../src/lib/crypto";
import { newId } from "../src/lib/id";
import { DEPOSITED_EVENT } from "../src/onchain/client";
import { confirmDeposit, type ConfirmDeps } from "../src/onchain/confirm";
import type { DepositEvent, IngestConfig, IngestOutcome } from "../src/onchain/ingest";
import { onchainProjectId } from "../src/onchain/project-id";
import { decodeDepositEvents, hasEnoughConfirmations } from "../src/onchain/tx";
import { NATIVE_TOKEN } from "../src/onchain/types";
import { findOrCreateProjectByWallet } from "../src/services/projects";

const MANAGER = "0x31d02e01406bf31dF857fD65865E03d4dD5ab82a" as const;
const TX = `0x${"ab".repeat(32)}` as const;
const BLOCK_HASH = `0x${"cd".repeat(32)}` as const;
const PAYER = "0x1111111111111111111111111111111111111111" as const;

function depositLog(projectId: string, amount: bigint, overrides: Partial<{
  address: string;
  transactionHash: string;
  logIndex: number;
}> = {}) {
  const topics = encodeEventTopics({
    abi: [DEPOSITED_EVENT],
    eventName: "Deposited",
    args: { projectId: projectId as `0x${string}`, payer: PAYER, token: NATIVE_TOKEN },
  });
  const data = encodeAbiParameters([{ type: "uint256" }], [amount]);
  return {
    address: overrides.address ?? MANAGER,
    topics,
    data,
    transactionHash: overrides.transactionHash ?? TX,
    logIndex: overrides.logIndex ?? 0,
  };
}

function fakeClient(receipt: unknown, head: bigint = 100n) {
  return {
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => head,
  } as unknown as ConfirmDeps["client"];
}

const stubConfig = {} as IngestConfig;

function deps(overrides: Partial<ConfirmDeps> = {}): ConfirmDeps {
  const projectId = "prj_confirm";
  return {
    client: fakeClient({
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      logs: [depositLog(onchainProjectId(projectId), 10n ** 17n)],
    }),
    depositManager: MANAGER,
    confirmations: 1,
    config: stubConfig,
    projectId,
    projectOnchainId: onchainProjectId(projectId),
    ingest: async () => {
      throw new Error("ingest tidak diekspektasikan dipanggil");
    },
    getBalanceMicro: async () => 300_000_000,
    ...overrides,
  };
}

// ── helper murni ─────────────────────────────────────────────────────────────

describe("onchain tx helpers", () => {
  test("hasEnoughConfirmations: blok head = 1 konfirmasi", () => {
    expect(hasEnoughConfirmations(100n, 100n, 1)).toBe(true);
    expect(hasEnoughConfirmations(100n, 100n, 2)).toBe(false);
    expect(hasEnoughConfirmations(98n, 100n, 3)).toBe(true);
    expect(hasEnoughConfirmations(99n, 100n, 3)).toBe(false);
    expect(hasEnoughConfirmations(null, 100n, 1)).toBe(false);
  });

  test("decodeDepositEvents: mendekode log Deposited + metadata blok", () => {
    const projectId = onchainProjectId("prj_decode");
    const events = decodeDepositEvents(
      {
        blockNumber: 100n,
        blockHash: BLOCK_HASH,
        logs: [depositLog(projectId, 123n)],
      },
      MANAGER,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      chainTx: TX,
      logIndex: 0,
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      projectId,
      token: NATIVE_TOKEN,
      amountRaw: 123n,
    });
  });

  test("decodeDepositEvents: blockNumber null tetap tidak mengisi metadata palsu", () => {
    const projectId = onchainProjectId("prj_decode_null");
    const events = decodeDepositEvents(
      {
        blockNumber: null,
        blockHash: null,
        logs: [depositLog(projectId, 1n)],
      },
      MANAGER,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.blockNumber).toBeUndefined();
    expect(events[0]?.blockHash).toBeUndefined();
  });

  test("decodeDepositEvents: log alamat lain dilewati", () => {
    const other = "0x00000000000000000000000000000000000000ff";
    const events = decodeDepositEvents(
      { logs: [depositLog(onchainProjectId("prj"), 1n, { address: other })] },
      MANAGER,
    );
    expect(events).toHaveLength(0);
  });

  test("decodeDepositEvents: log event lain dilewati (tak melempar)", () => {
    const events = decodeDepositEvents(
      {
        logs: [
          {
            address: MANAGER,
            topics: [`0x${"00".repeat(32)}`],
            data: "0x",
            transactionHash: TX,
            logIndex: 0,
          },
        ],
      },
      MANAGER,
    );
    expect(events).toHaveLength(0);
  });
});

// ── confirmDeposit ───────────────────────────────────────────────────────────

describe("confirmDeposit", () => {
  test("receipt belum ada → pending", async () => {
    const result = await confirmDeposit(TX, deps({ client: fakeClient(null) }));
    expect(result.status).toBe("pending");
  });

  test("viem melempar receipt-not-found → pending, bukan 502", async () => {
    const notFound = Object.assign(
      new Error(`Transaction receipt with hash "${TX}" could not be found.`),
      { name: "TransactionReceiptNotFoundError" },
    );
    const result = await confirmDeposit(
      TX,
      deps({
        client: {
          getTransactionReceipt: async () => {
            throw notFound;
          },
          getBlockNumber: async () => 100n,
        } as unknown as ConfirmDeps["client"],
      }),
    );
    expect(result.status).toBe("pending");
  });

  test("konfirmasi belum cukup → pending", async () => {
    const result = await confirmDeposit(
      TX,
      deps({
        client: fakeClient(
          { blockNumber: 100n, logs: [depositLog(onchainProjectId("prj_confirm"), 1n)] },
          100n,
        ),
        confirmations: 5,
      }),
    );
    expect(result.status).toBe("pending");
  });

  test("sukses → credited + metadata blok diteruskan + saldo terbaru", async () => {
    const credited: IngestOutcome = {
      status: "credited",
      depositId: "dep_1",
      lotId: "lot_1",
      creditsMicro: 300_000_000,
      usdValue: "3.00000000",
    };
    let seenEvent: DepositEvent | undefined;
    const result = await confirmDeposit(
      TX,
      deps({
        ingest: async (event) => {
          seenEvent = event;
          return credited;
        },
        getBalanceMicro: async () => 330_000_000,
      }),
    );
    expect(result).toMatchObject({
      status: "credited",
      credits_added: 300,
      balance_credits: 330,
      tx_hash: TX,
    });
    expect(seenEvent?.blockNumber).toBe(100n);
    expect(seenEvent?.blockHash).toBe(BLOCK_HASH);
  });

  test("diproses ulang → duplicate, credits_added 0", async () => {
    const result = await confirmDeposit(
      TX,
      deps({ ingest: async () => ({ status: "duplicate", depositId: "dep_1" }) }),
    );
    expect(result).toMatchObject({ status: "duplicate", credits_added: 0 });
  });

  test("melebihi cap → over_cap", async () => {
    const result = await confirmDeposit(
      TX,
      deps({
        ingest: async () => ({ status: "over_cap", depositId: "dep_1", usdValue: "1001.00000000" }),
      }),
    );
    expect(result).toMatchObject({ status: "over_cap", usd_value: "1001.00000000" });
  });

  test("harga tak tersedia → unpriced", async () => {
    const result = await confirmDeposit(
      TX,
      deps({
        ingest: async () => ({ status: "unpriced", depositId: "dep_1", reason: "tanpa feed" }),
      }),
    );
    expect(result).toMatchObject({ status: "unpriced", reason: "tanpa feed" });
  });

  test("deposit milik project lain → 403 NOT_YOUR_DEPOSIT", async () => {
    await expect(
      confirmDeposit(
        TX,
        deps({
          projectOnchainId: onchainProjectId("prj_lain"),
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "NOT_YOUR_DEPOSIT" });
  });

  test("tanpa log deposit → 400 NO_DEPOSIT_LOG", async () => {
    await expect(
      confirmDeposit(TX, deps({ client: fakeClient({ blockNumber: 100n, logs: [] }) })),
    ).rejects.toMatchObject({ status: 400, code: "NO_DEPOSIT_LOG" });
  });

  test("project belum punya onchain id → 409", async () => {
    await expect(
      confirmDeposit(TX, deps({ projectOnchainId: null })),
    ).rejects.toMatchObject({ status: 409, code: "PROJECT_NOT_READY" });
  });
});

// ── route (auth & validasi) ─────────────────────────────────────────────────

describe("deposit confirm route", () => {
  test("tanpa auth → 401", async () => {
    const res = await app.request("/v1/deposits/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_hash: TX }),
    });
    expect(res.status).toBe(401);
  });

  test("body tidak valid → 400 (setelah auth)", async () => {
    const wallet = `0x${randomBytes(20).toString("hex")}`;
    const project = await findOrCreateProjectByWallet(wallet);
    const generated = generateApiKey();
    await db.insert(apiKeys).values({
      id: newId("key"),
      projectId: project.id,
      prefix: generated.prefix,
      hash: hashSecret(generated.secret),
      label: "confirm-route-test",
    });

    const res = await app.request("/v1/deposits/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${generated.secret}`,
      },
      body: JSON.stringify({ tx_hash: "bukan-hash" }),
    });
    expect(res.status).toBe(400);
  });
});
