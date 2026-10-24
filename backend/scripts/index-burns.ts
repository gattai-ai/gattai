import "dotenv/config";
import { createBurnIndexer } from "../src/burn/indexer";
import { env } from "../src/env";
import { createRobinhoodClient } from "../src/onchain/client";
import { loadCursor, saveCursor } from "../src/onchain/cursor";
import { acquireLeaderLock } from "../src/onchain/lock";

/**
 * Backfill satu-kali untuk burn token GATTAI.
 *
 * Server API sudah menjalankan indexer yang sama; skrip ini untuk catch-up
 * manual setelah deploy/migrasi. Idempotent per `(tx, log)`, jadi aman
 * dijalankan berulang.
 */

const BURN_LOCK_KEY = 0x6275726e;

const tokenAddress = env.burnTokenAddress;
if (!tokenAddress) {
  throw new Error("BURN_TOKEN_ADDRESS wajib diisi untuk backfill burn.");
}

const lock = await acquireLeaderLock(BURN_LOCK_KEY);
if (!lock) {
  console.log("Burn indexer lain sedang berjalan (advisory lock dipegang). Keluar.");
  process.exit(0);
}

try {
  const client = createRobinhoodClient();
  const fromBlock =
    (await loadCursor("burn-indexer")) ??
    env.burnIndexerFromBlock ??
    (await client.getBlockNumber());

  const indexer = createBurnIndexer({
    client,
    tokenAddress: tokenAddress as `0x${string}`,
    decimals: env.burnTokenDecimals,
    fromBlock,
    batchBlocks: env.burnIndexerBatchBlocks,
    pollIntervalMs: env.burnIndexerPollIntervalMs,
    confirmations: env.burnConfirmations,
    deadAddresses: new Set(env.burnDeadAddresses),
    teamWallets: new Set(env.teamBurnWallets),
    lookbackBlocks: BigInt(env.burnIndexerReorgLookback),
    persistCursor: (cursor) => saveCursor("burn-indexer", cursor),
    onOutcome: (event) =>
      console.log(
        `[burn:index] ${event.chainTx}#${event.logIndex} → ${event.amountRaw.toString()} base-unit`,
      ),
    onError: (error) =>
      console.warn("[burn:index]", error instanceof Error ? error.message : error),
  });

  let previous = -1n;
  for (;;) {
    const result = await indexer.tick();
    console.log(
      `[burn:index] head=${result.head} safe=${result.toBlock} cursor=${indexer.cursor()} processed=${result.processed}`,
    );
    if (indexer.cursor() > result.toBlock) break;
    if (indexer.cursor() === previous) {
      console.log("[burn:index] tidak ada kemajuan; berhenti agar tidak loop.");
      break;
    }
    previous = indexer.cursor();
  }
} finally {
  await lock.release();
}
