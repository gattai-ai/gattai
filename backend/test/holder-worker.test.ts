import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import app from "../src/app";
import { db, pool } from "../src/db";
import { holderSnapshots, holderWorkerState } from "../src/db/schema";
import { pruneHolderSnapshots } from "../src/holder/retention";
import {
  computeNextDelay,
  runHolderSnapshotCycle,
  startHolderSnapshotWorker,
  type HolderSnapshotCycleResult,
} from "../src/holder/snapshot-worker";
import { newId } from "../src/lib/id";
import {
  getHolderWorkerHealth,
  getHolderWorkerState,
  markHolderCycleFailure,
  markHolderCycleStarted,
  markHolderCycleSuccess,
} from "../src/holder/worker-state";

const WALLET = "0x00000000000000000000000000000000000000dd";

function onchain(blockNumber: bigint) {
  return {
    balanceRaw: 60_000n * 10n ** 18n,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    blockTimestamp: 1_700_000_000n,
  };
}

async function cleanup() {
  await db.delete(holderSnapshots).where(eq(holderSnapshots.wallet, WALLET));
  await db.delete(holderWorkerState).where(eq(holderWorkerState.id, "holder-snapshot"));
}

describe("holder snapshot worker", () => {
  test("siklus mencatat snapshot, idempotent per block, dan lanjut ke block baru", async () => {
    await cleanup();
    try {
      const first = await runHolderSnapshotCycle({
        wallets: [WALLET],
        force: true,
        fetchBalance: async () => onchain(900_001n),
      });
      expect(first).toMatchObject({
        scanned: 1,
        recorded: 1,
        skipped: 0,
        errors: 0,
        skippedByLock: false,
        skippedByLastSuccess: false,
      });

      // Block yang sama: recordSnapshot mengembalikan baris lama, tidak duplikat.
      const sameBlock = await runHolderSnapshotCycle({
        wallets: [WALLET],
        force: true,
        fetchBalance: async () => onchain(900_001n),
      });
      expect(sameBlock.recorded).toBe(1);
      expect(
        await db.select().from(holderSnapshots).where(eq(holderSnapshots.wallet, WALLET)),
      ).toHaveLength(1);

      const nextBlock = await runHolderSnapshotCycle({
        wallets: [WALLET],
        force: true,
        fetchBalance: async () => onchain(900_002n),
      });
      expect(nextBlock.recorded).toBe(1);
      expect(
        await db.select().from(holderSnapshots).where(eq(holderSnapshots.wallet, WALLET)),
      ).toHaveLength(2);

      const failedRpc = await runHolderSnapshotCycle({
        wallets: [WALLET],
        force: true,
        fetchBalance: async () => null,
      });
      expect(failedRpc.skipped).toBe(1);
      expect(failedRpc.recorded).toBe(0);
      expect(failedRpc.errors).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("guard last-success melewati siklus kedua, force tetap menjalankan", async () => {
    await cleanup();
    try {
      const first = await runHolderSnapshotCycle({
        wallets: [WALLET],
        fetchBalance: async () => onchain(900_010n),
      });
      expect(first.recorded).toBe(1);
      expect(first.lastSuccessAt).not.toBeNull();

      const guarded = await runHolderSnapshotCycle({
        wallets: [WALLET],
        fetchBalance: async () => onchain(900_011n),
      });
      expect(guarded.skippedByLastSuccess).toBe(true);
      expect(guarded.scanned).toBe(0);
      expect(guarded.recorded).toBe(0);

      const forced = await runHolderSnapshotCycle({
        wallets: [WALLET],
        force: true,
        fetchBalance: async () => onchain(900_012n),
      });
      expect(forced.skippedByLastSuccess).toBe(false);
      expect(forced.recorded).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("siklus melewati instance lain yang memegang advisory lock", async () => {
    await cleanup();
    const lockClient = await pool.connect();
    try {
      await lockClient.query("select pg_advisory_lock(hashtext($1))", ["holder-snapshot-worker"]);
      const result = await runHolderSnapshotCycle({
        wallets: [WALLET],
        force: true,
        fetchBalance: async () => onchain(900_003n),
      });
      expect(result.skippedByLock).toBe(true);
      expect(result.scanned).toBe(0);
      expect(
        await db.select().from(holderSnapshots).where(eq(holderSnapshots.wallet, WALLET)),
      ).toHaveLength(0);
    } finally {
      await lockClient.query("select pg_advisory_unlock(hashtext($1))", [
        "holder-snapshot-worker",
      ]);
      lockClient.release();
      await cleanup();
    }
  });

  test("konkurensi RPC dibatasi oleh opsi concurrency", async () => {
    const wallets = Array.from(
      { length: 10 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    await db.delete(holderSnapshots).where(inArray(holderSnapshots.wallet, wallets));
    await cleanup();
    try {
      let active = 0;
      let maxActive = 0;
      const result = await runHolderSnapshotCycle({
        wallets,
        force: true,
        concurrency: 3,
        fetchBalance: async (wallet) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          const index = wallets.indexOf(wallet);
          return onchain(900_100n + BigInt(index));
        },
      });
      expect(result.scanned).toBe(10);
      expect(result.recorded).toBe(10);
      expect(result.errors).toBe(0);
      expect(maxActive).toBeLessThanOrEqual(3);
      expect(maxActive).toBeGreaterThan(1);
    } finally {
      await db.delete(holderSnapshots).where(inArray(holderSnapshots.wallet, wallets));
      await cleanup();
    }
  });

  test("retensi menghapus snapshot lama tetapi menyimpan N terbaru per wallet", async () => {
    const wallet = "0x00000000000000000000000000000000000000ef";
    await db.delete(holderSnapshots).where(eq(holderSnapshots.wallet, wallet));
    try {
      const old = new Date("2025-01-01T00:00:00.000Z");
      const recent = new Date("2026-10-20T00:00:00.000Z");
      const rows = Array.from({ length: 12 }, (_, index) => ({
        id: newId("snp"),
        wallet,
        balanceRaw: "1000000000000000000",
        balanceTokens: "1.0000",
        blockNumber: 10_000 + index,
        blockHash: `0x${(10_000 + index).toString(16).padStart(64, "0")}`,
        takenAt: old,
      }));
      rows.push({
        id: newId("snp"),
        wallet,
        balanceRaw: "1000000000000000000",
        balanceTokens: "1.0000",
        blockNumber: 20_000,
        blockHash: `0x${(20_000).toString(16).padStart(64, "0")}`,
        takenAt: recent,
      });
      await db.insert(holderSnapshots).values(rows);

      const pruned = await pruneHolderSnapshots({
        retentionDays: 90,
        minPerWallet: 10,
        now: new Date("2026-10-25T00:00:00.000Z"),
      });

      expect(pruned).toBe(2);
      const remaining = await db
        .select()
        .from(holderSnapshots)
        .where(eq(holderSnapshots.wallet, wallet));
      expect(remaining).toHaveLength(11);
      expect(remaining.some((row) => row.blockNumber === 20_000)).toBe(true);
    } finally {
      await db.delete(holderSnapshots).where(eq(holderSnapshots.wallet, wallet));
    }
  });

  test("siklus sukses menjalankan retensi dan melaporkan hasilnya", async () => {
    await cleanup();
    try {
      const result = await runHolderSnapshotCycle({
        wallets: [WALLET],
        force: true,
        prune: true,
        fetchBalance: async () => onchain(900_030n),
        pruneSnapshots: async () => 7,
      });
      expect(result.pruned).toBe(7);
      expect(result.pruneError).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("kegagalan retensi tidak menggagalkan snapshot yang sudah sukses", async () => {
    await cleanup();
    try {
      const result = await runHolderSnapshotCycle({
        wallets: [WALLET],
        force: true,
        prune: true,
        fetchBalance: async () => onchain(900_031n),
        pruneSnapshots: async () => {
          throw new Error("prune down");
        },
      });
      expect(result.recorded).toBe(1);
      expect(result.pruned).toBe(0);
      expect(result.pruneError).toContain("prune down");
    } finally {
      await cleanup();
    }
  });

  test("health worker melaporkan status dan tidak membocorkan wallet", async () => {
    await cleanup();
    const response = await app.request("/health/holder");
    expect([200, 503]).toContain(response.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.status).toBe("string");
    expect(body).toHaveProperty("last_success_at");
    expect(JSON.stringify(body)).not.toContain(WALLET);
  });

  test("state worker mencatat sukses dan error untuk health", async () => {
    await cleanup();
    try {
      const startedAt = new Date(Date.now() - 2000);
      await markHolderCycleStarted(startedAt);
      const finishedAt = new Date();
      await markHolderCycleSuccess({
        startedAt,
        finishedAt,
        scanned: 2,
        recorded: 2,
        skipped: 0,
        errors: 0,
      });
      const state = await getHolderWorkerState();
      expect(state?.lastScanned).toBe(2);
      expect(state?.lastRecorded).toBe(2);
      expect(state?.lastSuccessAt?.toISOString()).toBe(finishedAt.toISOString());

      const ok = await getHolderWorkerHealth();
      expect(ok.interval_seconds).toBeGreaterThan(0);
      if (ok.enabled) {
        expect(ok.last_success_at).toBe(finishedAt.toISOString());
        expect(ok.status).toBe("ok");
      }

      await markHolderCycleFailure({
        startedAt: finishedAt,
        finishedAt: new Date(finishedAt.getTime() + 1000),
        error: new Error("rpc timeout"),
      });
      const degraded = await getHolderWorkerHealth();
      expect(degraded.last_error_present).toBe(true);
      if (degraded.enabled) {
        expect(["degraded", "stale"]).toContain(degraded.status);
      }
    } finally {
      await cleanup();
    }
  });

  test("computeNextDelay menerapkan jitter simetris dan batas minimum", () => {
    expect(computeNextDelay(10_000, 0.1, () => 0)).toBe(9000);
    expect(computeNextDelay(10_000, 0.1, () => 1)).toBe(11_000);
    expect(computeNextDelay(10_000, 0.1, () => 0.5)).toBe(10_000);
    expect(computeNextDelay(100, 0.5, () => 0)).toBe(1000);
    expect(computeNextDelay(10_000, 2, () => 1)).toBe(15_000);
  });

  test("stop menghentikan penjadwalan siklus berikutnya", () => {
    let calls = 0;
    const result: HolderSnapshotCycleResult = {
      scanned: 0,
      recorded: 0,
      skipped: 0,
      errors: 0,
      skippedByLock: false,
      skippedByLastSuccess: false,
      lastSuccessAt: null,
      pruned: 0,
      pruneError: null,
    };
    const worker = startHolderSnapshotWorker({
      intervalMs: 60_000,
      jitterRatio: 0,
      runCycle: async () => {
        calls += 1;
        return result;
      },
    });

    // runOnStart memanggil siklus secara sinkron sampai await pertama.
    expect(calls).toBe(1);
    worker.stop();
    expect(calls).toBe(1);
  });
});
