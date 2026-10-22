/**
 * Worker indexer deposit onchain (Fase 2).
 *
 * Membaca event `Deposited` dari `DEPOSIT_MANAGER_ADDRESS`, menunggu
 * `DEPOSIT_CONFIRMATIONS`, lalu mengkreditkan lot lewat `ingestDeposit`.
 *
 * Pemakaian:
 *   bun run indexer                 # catch-up sekali (dari INDEXER_FROM_BLOCK)
 *   bun run indexer --from-block=123 # override blok awal
 *   bun run indexer --live          # polling terus-menerus
 *
 * Env: ROBINHOOD_RPC_URL, DEPOSIT_MANAGER_ADDRESS (wajib).
 * Opsional: CHAIN_ID, DEPOSIT_CONFIRMATIONS, INDEXER_FROM_BLOCK,
 *           INDEXER_POLL_INTERVAL_MS, INDEXER_BATCH_BLOCKS, GATTAI_TOKEN_ADDRESS,
 *           USDG_TOKEN_ADDRESS, CHAINLINK_ETH_USD_FEED, GATTAI_TWAP_POOL,
 *           ETH_USD_PRICE, GATTAI_USD_PRICE, ALLOW_MANUAL_PRICES.
 */

import "dotenv/config";
import { pool } from "../src/db";
import { env } from "../src/env";
import { buildIngestConfig } from "../src/onchain/config";
import { createRobinhoodClient } from "../src/onchain/client";
import { loadCursor, saveCursor } from "../src/onchain/cursor";
import { deadLetterFromEvent } from "../src/onchain/dead-letter";
import { createDepositIndexer } from "../src/onchain/indexer";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CURSOR_NAME = "deposit-reconciler";

function argValue(flag: string): string | undefined {
  const prefix = `${flag}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

async function main(): Promise<void> {
  const depositManager = env.depositManagerAddress;
  if (!depositManager || !ADDRESS_RE.test(depositManager)) {
    throw new Error(
      "DEPOSIT_MANAGER_ADDRESS belum diisi/invalid. Deploy kontrak (Fase 2) lalu set alamatnya di .env.",
    );
  }

  const live = process.argv.includes("--live");
  const client = createRobinhoodClient();

  const head = await client.getBlockNumber();
  const fromBlockArg = argValue("--from-block");
  const persisted = fromBlockArg ? null : await loadCursor(CURSOR_NAME);
  const fromBlock =
    fromBlockArg !== undefined
      ? BigInt(fromBlockArg)
      : (persisted ?? env.indexerFromBlock ?? head);

  if (persisted !== null) {
    console.log(`[indexer] melanjutkan dari kursor tersimpan ${persisted}`);
  } else if (fromBlockArg === undefined && env.indexerFromBlock === undefined) {
    console.log(
      `[indexer] INDEXER_FROM_BLOCK belum diisi; mulai dari head ${head}. ` +
        "Set INDEXER_FROM_BLOCK (blok deploy DepositManager) untuk catch-up dari awal.",
    );
  }

  const indexer = createDepositIndexer({
    client,
    depositManager: depositManager as `0x${string}`,
    fromBlock,
    batchBlocks: env.indexerBatchBlocks,
    pollIntervalMs: env.indexerPollIntervalMs,
    ...buildIngestConfig(client),
    persistCursor: (cursor) => saveCursor(CURSOR_NAME, cursor),
    onPoisonPill: (event, error, attempts) =>
      deadLetterFromEvent(event, error, attempts).then(() =>
        console.error(
          `[indexer] dead-letter dicatat: ${event.chainTx}#${event.logIndex} setelah ${attempts} percobaan`,
        ),
      ),
    onOutcome: (event, outcome) => {
      console.log(
        `[indexer] ${event.chainTx}#${event.logIndex} token=${event.token} amount=${event.amountRaw} → ${outcome.status}`,
        outcome.status === "credited" ? `+${outcome.creditsMicro} micro` : "",
      );
    },
    onError: (error) => {
      console.error("[indexer] error:", error instanceof Error ? error.message : error);
    },
  });

  if (!live) {
    const result = await indexer.tick();
    console.log(
      `[indexer] catch-up selesai: head=${result.head} toBlock=${result.toBlock} credited=${result.processed} cursor=${indexer.cursor()}`,
    );
    return;
  }

  console.log(
    `[indexer] live mode: poll tiap ${env.indexerPollIntervalMs} ms, confirmations=${env.depositConfirmations}`,
  );
  indexer.start();
  // Tahan proses tetap hidup sampai dihentikan (Ctrl+C).
  await new Promise<void>(() => {});
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("indexer gagal:", error instanceof Error ? error.message : error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
