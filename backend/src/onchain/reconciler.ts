import type { PublicClient } from "viem";
import { pool } from "../db";
import { env } from "../env";
import { createRobinhoodClient } from "./client";
import { buildIngestConfig } from "./config";
import { loadCursor, saveCursor } from "./cursor";
import { deadLetterFromEvent } from "./dead-letter";
import { createDepositIndexer, type DepositIndexer } from "./indexer";
import { retryPendingDeposits } from "./pending";
import { reconcileReorgs } from "./reorg";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CURSOR_NAME = "deposit-reconciler";
/** Kunci advisory lock global untuk reconciler deposit (`gattai` dalam hex). */
const LOCK_KEY = 0x676174746169;
const LOG_THROTTLE_MS = 60_000;

/**
 * Jalur "penjaga" (reconciler): indexer deposit yang hidup di dalam proses API.
 *
 * Menjamin deposit tetap terkredit walau:
 *  - user menutup tab sebelum memanggil `/v1/deposits/confirm`;
 *  - panggilan confirm gagal sesaat (RPC/timeout).
 *
 * Idempoten dengan jalur confirm (klaim `(chain_tx, log_index)`), jadi
 * keduanya boleh berjalan bersamaan tanpa dobel-kredit.
 *
 * Penguatan:
 *  - P1.1 kursor persisten (`chain_cursors`) → tidak scan ulang saat restart;
 *  - P1.2 RPC fallback/timeout + backoff + log throttled;
 *  - P1.3 single-leader (`pg_advisory_lock`) → aman walau ada >1 replika;
 *  - P0.2 dead-letter untuk log poison-pill;
 *  - P0.3 penjaga reorg (perbaiki inklusi ulang, tandai yang hilang).
 *
 * Mengembalikan `null` bila nonaktif / belum dikonfigurasi (server tetap jalan).
 */
export async function startDepositReconciler(): Promise<DepositIndexer | null> {
  if (!env.indexerEnabled) {
    console.log("[startup] deposit reconciler dimatikan (INDEXER_ENABLED=false)");
    return null;
  }

  const depositManager = env.depositManagerAddress;
  if (!depositManager || !ADDRESS_RE.test(depositManager) || !env.robinhoodRpcUrl) {
    return null;
  }

  // P1.3: hanya satu proses yang menjalankan reconciler (single-leader).
  const lock = await acquireLeaderLock();
  if (!lock) {
    console.log(
      "[startup] deposit reconciler: instance lain sudah memegang kunci; reconciler dilewati.",
    );
    return null;
  }

  const client = createRobinhoodClient();
  const logError = createThrottledLogger("[reconciler]");

  // P1.1: lanjutkan dari kursor persisten bila ada.
  let fromBlock: bigint;
  const persisted = await loadCursor(CURSOR_NAME).catch((error) => {
    logError(error);
    return null;
  });
  if (persisted !== null) {
    fromBlock = persisted;
    console.log(`[startup] deposit reconciler melanjutkan dari kursor tersimpan ${fromBlock}`);
  } else {
    fromBlock = env.indexerFromBlock ?? (await client.getBlockNumber());
    if (env.indexerFromBlock === undefined) {
      console.log(
        `[startup] INDEXER_FROM_BLOCK belum diisi; reconciler mulai dari head ${fromBlock}.`,
      );
    }
  }

  const ingestConfig = buildIngestConfig(client);
  const indexer = createDepositIndexer({
    client,
    depositManager: depositManager as `0x${string}`,
    fromBlock,
    batchBlocks: env.indexerBatchBlocks,
    pollIntervalMs: env.indexerPollIntervalMs,
    ...ingestConfig,
    persistCursor: (cursor) => saveCursor(CURSOR_NAME, cursor).catch(logError),
    onPoisonPill: (event, error, attempts) =>
      deadLetterFromEvent(event, error, attempts).then(() =>
        console.warn(
          `[reconciler] dead-letter dicatat: ${event.chainTx}#${event.logIndex} setelah ${attempts} percobaan`,
        ),
      ),
    onOutcome: (event, outcome) => {
      if (outcome.status === "credited") {
        console.log(
          `[reconciler] ${event.chainTx}#${event.logIndex} → credited +${outcome.creditsMicro} micro`,
        );
      }
    },
    onError: logError,
  });

  // P0.3: penjaga reorg berjalan tiap siklus polling.
  const reorgTimer = setInterval(() => {
    void runReorgCheck(client, logError);
  }, env.indexerPollIntervalMs);

  // A2: deposit yang tertinggal `pending` karena harga belum tersedia tidak
  // boleh hilang hanya karena kursor indexer sudah melewatinya. Coba ulang
  // secara berkala; `ingestDeposit` tetap idempoten terhadap jalur confirm.
  const pendingTimer = setInterval(() => {
    void retryPendingDeposits({
      config: ingestConfig,
      olderThanMs: 60_000,
      limit: 100,
      onOutcome: (depositId, outcome) => {
        if (outcome.status === "credited") {
          console.log(`[reconciler] pending ${depositId} → credited +${outcome.creditsMicro} micro`);
        }
      },
      onError: (depositId, error) =>
        logError(
          new Error(
            `[reconciler] retry pending ${depositId} gagal: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        ),
    }).catch(logError);
  }, Math.max(env.indexerPollIntervalMs, 60_000));

  const stopIndexer = indexer.stop.bind(indexer);
  indexer.stop = () => {
    stopIndexer();
    clearInterval(reorgTimer);
    clearInterval(pendingTimer);
    void lock.release();
  };

  indexer.start();
  console.log(
    `[startup] deposit reconciler aktif (poll ${env.indexerPollIntervalMs} ms, confirmations=${env.depositConfirmations}, reorg-lookback=${env.indexerReorgLookback})`,
  );
  return indexer;
}

async function runReorgCheck(
  client: PublicClient,
  logError: (error: unknown) => void,
): Promise<void> {
  try {
    const head = await client.getBlockNumber();
    const result = await reconcileReorgs(head, {
      client,
      lookbackBlocks: BigInt(env.indexerReorgLookback),
      onRepair: (info) =>
        console.warn(
          `[reconciler] reorg inklusi-ulang dirapikan: ${info.chainTx}#${info.logIndex} blok ${info.oldBlock} → ${info.newBlock}`,
        ),
      onFlag: (info) =>
        console.error(`[reconciler] PERLU TINJAUAN: ${info.reason}`),
    });
    if (result.flagged > 0) {
      console.warn(`[reconciler] ${result.flagged} deposit ditandai reorged`);
    }
    if (result.restored > 0) {
      console.warn(`[reconciler] ${result.restored} deposit reorged dipulihkan`);
    }
  } catch (error) {
    logError(error);
  }
}

/** Ambil advisory lock pada satu koneksi khusus yang ditahan selama proses hidup. */
async function acquireLeaderLock(): Promise<{ release: () => Promise<void> } | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [LOCK_KEY],
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }

  return {
    release: async () => {
      try {
        await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
      } finally {
        client.release();
      }
    },
  };
}

/** Logger yang menekan pesan berulang dalam satu jendela waktu (anti-spam). */
function createThrottledLogger(prefix: string): (error: unknown) => void {
  let last = 0;
  let suppressed = 0;
  return (error: unknown) => {
    const now = Date.now();
    if (now - last < LOG_THROTTLE_MS) {
      suppressed += 1;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const extra = suppressed > 0 ? ` (+${suppressed} error serupa disembunyikan)` : "";
    console.warn(prefix, message + extra);
    last = now;
    suppressed = 0;
  };
}
