import type { PublicClient } from "viem";
import { DEPOSITED_EVENT } from "./client";
import { ingestDeposit, type DepositEvent, type IngestConfig, type IngestOutcome } from "./ingest";

export interface IndexerOptions extends IngestConfig {
  client: PublicClient;
  /** Alamat DepositManager. */
  depositManager: `0x${string}`;
  /** Blok awal (inklusif) untuk catch-up. */
  fromBlock: bigint;
  /** Ukuran batch getLogs. */
  batchBlocks: number;
  /** Selang polling live (ms). */
  pollIntervalMs: number;
  /** Override ingest (untuk test); default `ingestDeposit`. */
  ingest?: (event: DepositEvent, config: IngestConfig) => Promise<IngestOutcome>;
  onOutcome?: (event: DepositEvent, outcome: IngestOutcome) => void;
  onError?: (error: unknown) => void;
  /** Dipanggil setiap kursor maju, untuk persistensi (P1.1). */
  persistCursor?: (cursor: bigint) => void | Promise<void>;
  /**
   * Dipanggil saat satu log dilewati karena poison pill (P0.2). Implementasi
   * produksi mencatat dead-letter tahan lama. Bila hook ini melempar, log
   * TIDAK dilewati (kursor ditahan) agar deposit tidak hilang diam-diam.
   */
  onPoisonPill?: (event: DepositEvent, error: unknown, attempts: number) => void | Promise<void>;
  /** Batas backoff saat error beruntun (ms). Default 60_000. */
  maxBackoffMs?: number;
}

export interface TickResult {
  processed: number;
  /** Log yang gagal infra pada tick ini (akan diulang tick berikut). */
  failed: number;
  fromBlock: bigint;
  toBlock: bigint;
  head: bigint;
}

export interface DepositIndexer {
  /** Proses semua blok yang sudah cukup konfirmasi. Mengembalikan ringkasan. */
  tick(): Promise<TickResult>;
  /** Head chain saat ini. */
  head(): Promise<bigint>;
  /** Posisi kursor (blok berikutnya yang belum diproses). */
  cursor(): bigint;
  /** Mulai polling berkala. */
  start(): void;
  /** Hentikan polling. */
  stop(): void;
}

/**
 * Indexer deposit: membaca event `Deposited`, menunggu `confirmations`,
 * lalu meneruskannya ke `ingestDeposit`. Aman diproses ulang (idempotent).
 *
 * Loop `start()` memakai setTimeout rekursif (bukan setInterval) sehingga
 * tidak ada tick tumpang-tindih dan mendukung backoff eksponensial saat RPC
 * bermasalah (P1.2).
 */
export function createDepositIndexer(options: IndexerOptions): DepositIndexer {
  let cursor = options.fromBlock;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let consecutiveErrors = 0;
  const ingest = options.ingest ?? ingestDeposit;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  // Hitung kegagalan infra beruntun per log agar satu log beracun tidak
  // menahan kursor selamanya (dilewati setelah ambang, dengan laporan).
  const consecutiveFailures = new Map<string, number>();
  const MAX_CONSECUTIVE_FAILURES = 10;

  async function tick(): Promise<TickResult> {
    const head = await options.client.getBlockNumber();
    const safeTo =
      head > BigInt(options.confirmations) ? head - BigInt(options.confirmations) : 0n;

    let processed = 0;
    let failed = 0;
    let failedFrom: bigint | null = null;
    if (cursor <= safeTo) {
      let from = cursor;
      // Berhenti mempersist begitu ada batch yang gagal, agar kursor tersimpan
      // tidak pernah melompati log yang belum tuntas.
      let canPersist = true;
      while (from <= safeTo) {
        const to = minBigInt(from + BigInt(options.batchBlocks) - 1n, safeTo);
        const logs = await options.client.getLogs({
          address: options.depositManager,
          event: DEPOSITED_EVENT,
          fromBlock: from,
          toBlock: to,
        });

        for (const log of logs) {
          const args = log.args;
          if (
            !args.projectId ||
            !args.payer ||
            !args.token ||
            args.amount === undefined ||
            log.transactionHash === null ||
            log.logIndex === null
          ) {
            continue;
          }

          const event: DepositEvent = {
            chainTx: log.transactionHash,
            logIndex: log.logIndex,
            blockNumber: log.blockNumber ?? undefined,
            blockHash: log.blockHash ?? undefined,
            projectId: args.projectId,
            payer: args.payer,
            token: args.token,
            amountRaw: args.amount,
          };

          const key = `${event.chainTx}:${event.logIndex}`;
          try {
            const outcome = await ingest(event, options);
            consecutiveFailures.delete(key);
            processed += outcome.status === "credited" ? 1 : 0;
            options.onOutcome?.(event, outcome);
          } catch (error) {
            const count = (consecutiveFailures.get(key) ?? 0) + 1;
            consecutiveFailures.set(key, count);

            if (count > MAX_CONSECUTIVE_FAILURES) {
              if (options.onPoisonPill) {
                try {
                  await options.onPoisonPill(event, error, count);
                } catch (hookError) {
                  // Tidak bisa mencatat dead-letter → JANGAN lewati; tahan kursor.
                  options.onError?.(hookError);
                  canPersist = false;
                  failed += 1;
                  const block = event.blockNumber ?? from;
                  failedFrom = failedFrom === null || block < failedFrom ? block : failedFrom;
                  continue;
                }
                consecutiveFailures.delete(key);
                options.onError?.(poisonPillError(key, error));
                continue;
              }
              // Tanpa handler dead-letter: perilaku lama, lewati dengan laporan.
              consecutiveFailures.delete(key);
              options.onError?.(poisonPillError(key, error));
              continue;
            }

            failed += 1;
            canPersist = false;
            const block = event.blockNumber ?? from;
            failedFrom = failedFrom === null || block < failedFrom ? block : failedFrom;
            options.onError?.(error);
          }
        }

        from = to + 1n;
        if (canPersist) await options.persistCursor?.(from);
      }
      // Kursor hanya maju melewati prefix yang tuntas; blok berisi log yang
      // gagal infra akan diproses ulang tick berikut (ingest idempotent).
      cursor = failedFrom ?? safeTo + 1n;
    }

    return { processed, failed, fromBlock: options.fromBlock, toBlock: safeTo, head };
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

function poisonPillError(key: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `[indexer] melewati log ${key} setelah kegagalan beruntun: ${message}`,
  );
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
