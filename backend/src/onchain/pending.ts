import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "../db";
import { deposits, projects } from "../db/schema";
import { ingestDeposit, type DepositEvent, type IngestConfig, type IngestOutcome } from "./ingest";

/**
 * Retry deposit `pending` yang tertinggal karena harga belum tersedia.
 *
 * Indexer sengaja tidak menahan kursor untuk `unpriced`: satu feed harga yang
 * sedang down tidak boleh menghentikan seluruh deposit setelahnya. Konsekuensinya
 * deposit tersebut harus dicoba ulang di luar siklus scan. Worker ini melakukannya
 * secara berkala dan idempoten (`ingestDeposit` mengklaim `(tx, log_index)`).
 */
export interface RetryPendingOptions {
  config: IngestConfig;
  /** Hanya deposit yang lebih tua dari ini (ms). Default 60 detik. */
  olderThanMs?: number;
  /** Batas per siklus. Default 100. */
  limit?: number;
  /** Batasi ke satu project (dipakai operasi manual/tes). */
  projectId?: string;
  /** Waktu acuan (untuk tes). */
  now?: number;
  onOutcome?: (depositId: string, outcome: IngestOutcome) => void;
  onError?: (depositId: string, error: unknown) => void;
}

export interface RetryPendingResult {
  checked: number;
  credited: number;
  stillPending: number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function retryPendingDeposits(
  input: RetryPendingOptions,
): Promise<RetryPendingResult> {
  const now = input.now ?? Date.now();
  const olderThanMs = input.olderThanMs ?? 60_000;

  const rows = await db
    .select({
      id: deposits.id,
      chainTx: deposits.chainTx,
      logIndex: deposits.logIndex,
      token: deposits.token,
      payer: deposits.payer,
      amountRaw: deposits.amountRaw,
      blockNumber: deposits.blockNumber,
      blockHash: deposits.blockHash,
      onchainId: projects.onchainId,
    })
    .from(deposits)
    .innerJoin(projects, eq(deposits.projectId, projects.id))
    .where(
      and(
        eq(deposits.status, "pending"),
        isNull(deposits.lotId),
        lt(deposits.createdAt, new Date(now - olderThanMs)),
        input.projectId ? eq(deposits.projectId, input.projectId) : undefined,
      ),
    )
    .limit(input.limit ?? 100);

  let credited = 0;
  let stillPending = 0;

  for (const row of rows) {
    if (!row.onchainId) continue;

    let amountRaw: bigint;
    try {
      amountRaw = BigInt(row.amountRaw);
    } catch {
      continue;
    }

    const event: DepositEvent = {
      chainTx: row.chainTx,
      logIndex: row.logIndex,
      projectId: row.onchainId,
      payer: row.payer ?? ZERO_ADDRESS,
      token: row.token,
      amountRaw,
      blockNumber: row.blockNumber !== null ? BigInt(row.blockNumber) : undefined,
      blockHash: row.blockHash ?? undefined,
    };

    try {
      const outcome = await ingestDeposit(event, input.config);
      input.onOutcome?.(row.id, outcome);
      if (outcome.status === "credited") credited += 1;
      else if (outcome.status === "unpriced" || outcome.status === "duplicate") {
        stillPending += 1;
      }
    } catch (error) {
      input.onError?.(row.id, error);
      stillPending += 1;
    }
  }

  return { checked: rows.length, credited, stillPending };
}
