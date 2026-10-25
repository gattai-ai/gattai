import { and, eq, gt } from "drizzle-orm";
import { db, pool } from "../db";
import { projects } from "../db/schema";
import {
  getHolderSnapshotBatchSize,
  getHolderSnapshotConcurrency,
  getHolderSnapshotIntervalMs,
  getHolderSnapshotJitterRatio,
} from "./config";
import { pruneHolderSnapshots } from "./retention";
import {
  fetchHolderConfirmedBlock,
  fetchOnchainTokenBalance,
  recordSnapshot,
} from "./service";
import {
  getHolderWorkerState,
  markHolderCycleFailure,
  markHolderCycleStarted,
  markHolderCycleSuccess,
} from "./worker-state";

/**
 * Worker snapshot saldo holder.
 *
 * Mengambil snapshot untuk seluruh wallet project aktif secara berkala.
 * Tanpa worker ini, aturan "dua snapshot berturut-turut" tidak pernah
 * terpenuhi karena endpoint status hanya mengambil snapshot pertama.
 */

const LOCK_KEY = "holder-snapshot-worker";

export interface HolderSnapshotCycleResult {
  scanned: number;
  recorded: number;
  skipped: number;
  /** Error per-wallet (mis. insert DB gagal). RPC null dihitung `skipped`. */
  errors: number;
  /** True bila instance lain sedang memegang lock. */
  skippedByLock: boolean;
  /** True bila siklus dilewati karena siklus sukses sebelumnya masih segar. */
  skippedByLastSuccess: boolean;
  /** Waktu siklus sukses terakhir yang diketahui (ISO), bila ada. */
  lastSuccessAt: string | null;
  /** Jumlah snapshot lama yang dihapus setelah siklus sukses. */
  pruned: number;
  /** Error retensi (non-fatal; snapshot tetap dianggap sukses). */
  pruneError: string | null;
}

export interface HolderSnapshotCycleOptions {
  /** Batasi jumlah wallet per siklus (0 = semua). */
  maxWallets?: number;
  /** Batasi ke wallet tertentu; dipakai test/CLI, bukan jalur produksi. */
  wallets?: string[];
  /** Abaikan guard last-success (dipakai CLI/manual). */
  force?: boolean;
  /** Batas RPC paralel; default dari config. */
  concurrency?: number;
  /** Dependency injection untuk test tanpa RPC/database nyata. */
  fetchBalance?: typeof fetchOnchainTokenBalance;
  recordSnapshot?: typeof recordSnapshot;
  /** Jalankan retensi setelah sukses; default true untuk scan penuh. */
  prune?: boolean;
  /** Dependency injection retensi untuk test. */
  pruneSnapshots?: typeof pruneHolderSnapshots;
}

/**
 * Jalankan satu siklus snapshot.
 *
 * Memakai advisory lock session-level pada satu koneksi khusus agar beberapa
 * instance server tidak mengambil snapshot yang sama secara bersamaan. Lock
 * dilepas eksplisit di `finally`; koneksi dikembalikan ke pool setelahnya.
 *
 * Siklus TIDAK dibungkus transaksi karena melibatkan banyak panggilan RPC.
 * Transaksi panjang akan menahan koneksi dan memperlambat autovacuum.
 */
export async function runHolderSnapshotCycle(
  options: number | HolderSnapshotCycleOptions = {},
): Promise<HolderSnapshotCycleResult> {
  const opts = typeof options === "number" ? { maxWallets: options } : options;
  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as locked",
      [LOCK_KEY],
    );
    if (!lock.rows[0]?.locked) {
      return {
        scanned: 0,
        recorded: 0,
        skipped: 0,
        errors: 0,
        skippedByLock: true,
        skippedByLastSuccess: false,
        lastSuccessAt: null,
        pruned: 0,
        pruneError: null,
      };
    }

    try {
      const state = await getHolderWorkerState();
      const lastSuccessMs = state?.lastSuccessAt?.getTime() ?? null;
      const intervalMs = getHolderSnapshotIntervalMs();
      const jitterRatio = getHolderSnapshotJitterRatio();
      const earliestNextCycleMs = intervalMs * (1 - jitterRatio);

      if (
        !opts.force &&
        lastSuccessMs !== null &&
        Date.now() - lastSuccessMs < earliestNextCycleMs
      ) {
        return {
          scanned: 0,
          recorded: 0,
          skipped: 0,
          errors: 0,
          skippedByLock: false,
          skippedByLastSuccess: true,
          lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
          pruned: 0,
          pruneError: null,
        };
      }

      const startedAt = new Date();
      await markHolderCycleStarted(startedAt);

      try {
        const maxWallets = opts.maxWallets ?? 0;
        // Satu block terkonfirmasi dipakai untuk seluruh wallet dalam siklus.
        // Ini mengurangi panggilan RPC sekaligus memastikan semua snapshot
        // dalam siklus merujuk ke state chain yang sama.
        const sharedBlock = opts.fetchBalance ? undefined : await fetchHolderConfirmedBlock();
        const fetchBalance =
          opts.fetchBalance ?? ((wallet: string) => fetchOnchainTokenBalance(wallet, sharedBlock));
        const saveSnapshot = opts.recordSnapshot ?? recordSnapshot;
        const concurrency = Math.max(
          1,
          Math.min(opts.concurrency ?? getHolderSnapshotConcurrency(), 20),
        );
        let scanned = 0;
        let recorded = 0;
        let skipped = 0;
        let errors = 0;
        let firstError: string | null = null;

        const processWallet = async (wallet: string) => {
          try {
            const onchain = await fetchBalance(wallet);
            if (!onchain) {
              skipped += 1;
              return;
            }
            await saveSnapshot(
              wallet,
              onchain.balanceRaw,
              onchain.blockNumber,
              onchain.blockHash,
              new Date(Number(onchain.blockTimestamp) * 1000),
            );
            recorded += 1;
          } catch (error) {
            errors += 1;
            skipped += 1;
            if (!firstError) {
              firstError = error instanceof Error ? error.message : String(error);
            }
          }
        };

        const processBatch = async (wallets: string[]) => {
          let nextIndex = 0;
          const workerCount = Math.min(concurrency, wallets.length);
          const processNext = async () => {
            while (true) {
              const index = nextIndex;
              nextIndex += 1;
              if (index >= wallets.length) return;
              await processWallet(wallets[index]);
            }
          };
          await Promise.all(Array.from({ length: workerCount }, () => processNext()));
        };

        if (opts.wallets) {
          const wallets =
            maxWallets > 0 ? opts.wallets.slice(0, maxWallets) : opts.wallets;
          scanned = wallets.length;
          await processBatch(wallets.map((wallet) => wallet.toLowerCase()));
        } else {
          // Keyset cursor per batch: jangan memuat puluhan ribu wallet ke
          // memori sekaligus. `owner_wallet` selalu lowercase (lihat
          // services/projects.ts), jadi perbandingan teks aman.
          const batchSize = getHolderSnapshotBatchSize();
          let lastWallet: string | null = null;
          while (true) {
            const remaining =
              maxWallets > 0 ? maxWallets - scanned : Number.POSITIVE_INFINITY;
            if (remaining <= 0) break;
            const limit = Math.min(batchSize, remaining);
            const rows = await db
              .selectDistinct({ wallet: projects.ownerWallet })
              .from(projects)
              .where(
                lastWallet
                  ? and(
                      eq(projects.status, "active"),
                      gt(projects.ownerWallet, lastWallet),
                    )
                  : eq(projects.status, "active"),
              )
              .orderBy(projects.ownerWallet)
              .limit(limit);
            if (rows.length === 0) break;
            const wallets = rows.map((row) => row.wallet);
            scanned += wallets.length;
            await processBatch(wallets);
            if (rows.length < limit) break;
            lastWallet = wallets[wallets.length - 1];
          }
        }

        const finishedAt = new Date();
        await markHolderCycleSuccess({
          startedAt,
          finishedAt,
          scanned,
          recorded,
          skipped,
          errors,
          errorMessage: firstError,
        });

        // Retensi bukan jalur kritis: snapshot yang sudah sukses jangan
        // dianggap gagal hanya karena prune error. Error tetap dilaporkan
        // lewat hasil siklus agar terlihat di log/CLI.
        let pruned = 0;
        let pruneError: string | null = null;
        const shouldPrune = opts.prune ?? !opts.wallets;
        if (shouldPrune) {
          try {
            const prune = opts.pruneSnapshots ?? pruneHolderSnapshots;
            pruned = await prune();
          } catch (error) {
            pruneError = error instanceof Error ? error.message : String(error);
          }
        }

        return {
          scanned,
          recorded,
          skipped,
          errors,
          skippedByLock: false,
          skippedByLastSuccess: false,
          lastSuccessAt: finishedAt.toISOString(),
          pruned,
          pruneError,
        };
      } catch (error) {
        await markHolderCycleFailure({ startedAt, error });
        throw error;
      }
    } finally {
      await lockClient.query("select pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}

/**
 * Hitung delay siklus berikutnya dengan jitter simetris.
 *
 * `random` bisa di-inject di test. Nilai minimum 1 detik mencegah busy loop
 * bila konfigurasi staging diisi terlalu kecil.
 */
export function computeNextDelay(
  intervalMs: number,
  jitterRatio: number,
  random: () => number = Math.random,
): number {
  const ratio = Math.min(0.5, Math.max(0, jitterRatio));
  const factor = 1 + (random() * 2 - 1) * ratio;
  return Math.max(1000, Math.round(intervalMs * factor));
}

export interface HolderSnapshotWorkerOptions {
  intervalMs: number;
  /** Jalankan satu siklus saat startup. Default true. */
  runOnStart?: boolean;
  /** Batasi jumlah wallet per siklus (0 = semua). */
  maxWallets?: number;
  /** Jitter interval; default dari config. */
  jitterRatio?: number;
  /** Random source untuk test jitter. */
  random?: () => number;
  onError?: (error: unknown) => void;
  onCycle?: (result: HolderSnapshotCycleResult) => void;
  /** Override siklus untuk test scheduler. */
  runCycle?: () => Promise<HolderSnapshotCycleResult>;
}

/**
 * Mulai worker dengan `setTimeout` rekursif supaya siklus tidak pernah
 * tumpang tindih bila satu siklus lebih lama dari interval.
 */
export function startHolderSnapshotWorker(
  options: HolderSnapshotWorkerOptions,
): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = options.runCycle
        ? await options.runCycle()
        : await runHolderSnapshotCycle(options.maxWallets ?? 0);
      options.onCycle?.(result);
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) {
      const jitterRatio = options.jitterRatio ?? getHolderSnapshotJitterRatio();
      timer = setTimeout(
        () => void tick(),
        computeNextDelay(options.intervalMs, jitterRatio, options.random),
      );
    }
  };

  if (options.runOnStart === false) {
    timer = setTimeout(
      () => void tick(),
      computeNextDelay(
        options.intervalMs,
        options.jitterRatio ?? getHolderSnapshotJitterRatio(),
        options.random,
      ),
    );
  } else {
    void tick();
  }

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
