import { parseAbiItem, type PublicClient } from "viem";
import { env } from "../env";
import { createRobinhoodClient } from "../onchain/client";
import { loadCursor, saveCursor } from "../onchain/cursor";
import { acquireLeaderLock } from "../onchain/lock";
import {
  deleteTokenBurn,
  ingestTokenBurn,
  listTokenBurnsForReorg,
  loadEpochBurnTxHashes,
  type IngestTokenBurnOptions,
  type TokenBurnEvent,
} from "./token-burns";

/** Signature event ERC-20 `Transfer`. */
export const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const CURSOR_NAME = "burn-indexer";
/** Kunci advisory lock global untuk burn indexer (`burn` dalam hex). */
const LOCK_KEY = 0x6275726e;

export interface BurnIndexerOptions {
  client: PublicClient;
  tokenAddress: `0x${string}`;
  decimals: number;
  /** Blok awal (inklusif) untuk backfill. */
  fromBlock: bigint;
  batchBlocks: number;
  pollIntervalMs: number;
  confirmations: number;
  deadAddresses: Set<string>;
  teamWallets: Set<string>;
  /** Kedalaman blok yang dicek ulang terhadap reorg. */
  lookbackBlocks: bigint;
  /** Override untuk test; default `ingestTokenBurn`. */
  ingest?: (event: TokenBurnEvent, options: IngestTokenBurnOptions) => Promise<void>;
  /** Override untuk test; default `loadEpochBurnTxHashes`. */
  loadEpochs?: () => Promise<Map<string, string>>;
  persistCursor?: (cursor: bigint) => void | Promise<void>;
  onOutcome?: (event: TokenBurnEvent, kind: string) => void;
  onError?: (error: unknown) => void;
  maxBackoffMs?: number;
}

export interface BurnTickResult {
  processed: number;
  fromBlock: bigint;
  toBlock: bigint;
  head: bigint;
}

export interface BurnIndexer {
  tick(): Promise<BurnTickResult>;
  head(): Promise<bigint>;
  cursor(): bigint;
  start(): void;
  stop(): void;
}

/**
 * Indexer transfer token ke dead address.
 *
 * Hanya log `Transfer` dengan `to` di `BURN_DEAD_ADDRESSES` yang dicatat.
 * Kursor hanya maju setelah satu batch `getLogs` selesai diproses; ingest
 * idempotent per `(tx, log)` sehingga retry aman.
 */
export function createBurnIndexer(options: BurnIndexerOptions): BurnIndexer {
  let cursor = options.fromBlock;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let consecutiveErrors = 0;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const ingest = options.ingest ?? ingestTokenBurn;
  const loadEpochs = options.loadEpochs ?? loadEpochBurnTxHashes;
  const blockTimestamps = new Map<string, Date | null>();

  async function blockTimestamp(blockNumber: bigint): Promise<Date | null> {
    const key = blockNumber.toString();
    if (blockTimestamps.has(key)) return blockTimestamps.get(key) ?? null;
    try {
      const block = await options.client.getBlock({ blockNumber });
      const date = new Date(Number(block.timestamp) * 1000);
      blockTimestamps.set(key, date);
      return date;
    } catch (error) {
      options.onError?.(error);
      // Jangan simpan kegagalan permanen: blok yang sama bisa dicoba lagi pada
      // tick berikutnya tanpa menahan burn itu sendiri.
      return null;
    }
  }

  async function checkReorgs(head: bigint): Promise<bigint | null> {
    const rows = await listTokenBurnsForReorg(head, options.lookbackBlocks);
    let rewind: bigint | null = null;

    for (const row of rows) {
      if (!row.blockHash) continue;
      let blockHash: string | null | undefined;
      try {
        const block = await options.client.getBlock({ blockNumber: BigInt(row.blockNumber) });
        blockHash = block.hash;
      } catch (error) {
        // Gangguan RPC bukan bukti reorg; lewati dan coba lagi tick berikut.
        options.onError?.(error);
        continue;
      }
      if (!blockHash || blockHash.toLowerCase() === row.blockHash.toLowerCase()) continue;

      await deleteTokenBurn(row.id);
      const blockNumber = BigInt(row.blockNumber);
      if (rewind === null || blockNumber < rewind) rewind = blockNumber;
      options.onError?.(
        new Error(
          `[burn-indexer] reorg: ${row.chainTx}#${row.logIndex} dihapus (blok ${row.blockNumber})`,
        ),
      );
    }

    return rewind;
  }

  async function tick(): Promise<BurnTickResult> {
    const head = await options.client.getBlockNumber();
    const confirmations = BigInt(options.confirmations);
    const safeTo = head > confirmations ? head - confirmations : 0n;

    // Deteksi reorg pada burn yang sudah tercatat. Bila ada, mundurkan kursor
    // agar log di blok baru diproses ulang (upsert idempotent).
    const rewind = await checkReorgs(head);
    if (rewind !== null && rewind < cursor) {
      cursor = rewind < options.fromBlock ? options.fromBlock : rewind;
      await options.persistCursor?.(cursor);
    }

    let processed = 0;
    if (cursor <= safeTo) {
      const epochByTx = await loadEpochs();
      const ingestOptions: IngestTokenBurnOptions = {
        teamWallets: options.teamWallets,
        epochByTx,
      };

      let from = cursor;
      while (from <= safeTo) {
        const to = minBigInt(from + BigInt(options.batchBlocks) - 1n, safeTo);
        const logs = await options.client.getLogs({
          address: options.tokenAddress,
          event: TRANSFER_EVENT,
          fromBlock: from,
          toBlock: to,
        });

        for (const log of logs) {
          const args = log.args;
          if (
            !args.from ||
            !args.to ||
            args.value === undefined ||
            log.transactionHash === null ||
            log.logIndex === null ||
            log.blockNumber === null
          ) {
            continue;
          }
          if (!options.deadAddresses.has(args.to.toLowerCase())) continue;

          const event: TokenBurnEvent = {
            chainTx: log.transactionHash,
            logIndex: log.logIndex,
            tokenAddress: options.tokenAddress,
            from: args.from,
            to: args.to,
            amountRaw: args.value,
            decimals: options.decimals,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            blockTimestamp: await blockTimestamp(log.blockNumber),
          };

          await ingest(event, ingestOptions);
          processed += 1;
          options.onOutcome?.(event, "indexed");
        }

        from = to + 1n;
        cursor = from;
        await options.persistCursor?.(cursor);
      }
    }

    return {
      processed,
      fromBlock: options.fromBlock,
      toBlock: safeTo,
      head,
    };
  }

  return {
    tick,
    head: () => options.client.getBlockNumber(),
    cursor: () => cursor,
    start: () => {
      if (running) return;
      running = true;

      const loop = async () => {
        try {
          await tick();
          consecutiveErrors = 0;
        } catch (error) {
          consecutiveErrors += 1;
          options.onError?.(error);
        }
        if (!running) return;
        const delay =
          consecutiveErrors > 0
            ? Math.min(options.pollIntervalMs * 2 ** (consecutiveErrors - 1), maxBackoffMs)
            : options.pollIntervalMs;
        timer = setTimeout(loop, delay);
      };

      timer = setTimeout(loop, options.pollIntervalMs);
    },
    stop: () => {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Jalankan burn indexer di dalam proses API. Mengembalikan `null` bila
 * nonaktif/belum dikonfigurasi (server tetap jalan).
 */
export async function startBurnIndexer(): Promise<BurnIndexer | null> {
  if (!env.burnIndexerEnabled) {
    console.log("[startup] burn indexer dimatikan (BURN_TOKEN_ADDRESS kosong atau BURN_INDEXER_ENABLED=false)");
    return null;
  }

  const tokenAddress = env.burnTokenAddress;
  if (!tokenAddress || !env.robinhoodRpcUrl) return null;

  // Single-leader: aman walau ada >1 replika API.
  const lock = await acquireLeaderLock(LOCK_KEY);
  if (!lock) {
    console.log("[startup] burn indexer: instance lain sudah memegang kunci; dilewati.");
    return null;
  }

  try {
    const client = createRobinhoodClient();
    let fromBlock: bigint;
    const persisted = await loadCursor(CURSOR_NAME).catch((error) => {
      logError(error);
      return null;
    });
    if (persisted !== null) {
      fromBlock = persisted;
      console.log(`[startup] burn indexer melanjutkan dari kursor tersimpan ${fromBlock}`);
    } else {
      fromBlock = env.burnIndexerFromBlock ?? (await client.getBlockNumber());
      if (env.burnIndexerFromBlock === undefined) {
        console.log(
          `[startup] BURN_INDEXER_FROM_BLOCK belum diisi; burn indexer mulai dari head ${fromBlock}.`,
        );
      }
    }

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
      persistCursor: (next) => saveCursor(CURSOR_NAME, next).catch(logError),
      onOutcome: (event) =>
        console.log(
          `[burn-indexer] ${event.chainTx}#${event.logIndex} → ${event.amountRaw.toString()} base-unit`,
        ),
      onError: logError,
    });

    const stopIndexer = indexer.stop.bind(indexer);
    indexer.stop = () => {
      stopIndexer();
      void lock.release();
    };

    indexer.start();
    console.log(
      `[startup] burn indexer aktif (token ${tokenAddress}, poll ${env.burnIndexerPollIntervalMs} ms, confirmations=${env.burnConfirmations})`,
    );
    return indexer;
  } catch (error) {
    // Jangan tinggalkan koneksi advisory lock menggantung bila startup gagal.
    await lock.release();
    throw error;
  }
}

let lastLogAt = 0;
let suppressedLogs = 0;

function logError(error: unknown): void {
  const now = Date.now();
  if (now - lastLogAt < 60_000) {
    suppressedLogs += 1;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const extra = suppressedLogs > 0 ? ` (+${suppressedLogs} error serupa disembunyikan)` : "";
  console.warn("[burn-indexer]", message + extra);
  lastLogAt = now;
  suppressedLogs = 0;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
