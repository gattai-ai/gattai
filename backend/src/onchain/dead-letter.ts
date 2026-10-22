import { db } from "../db";
import { depositDeadLetters } from "../db/schema";
import { newId } from "../lib/id";
import type { DepositEvent } from "./ingest";

/**
 * Dead-letter deposit (P0.2).
 *
 * Prinsipnya: **tidak boleh ada deposit yang hilang diam-diam**. Bila satu log
 * `Deposited` gagal diproses berulang (poison pill) atau tx-nya menghilang dari
 * rantai kanonik (reorg), kita catat baris dead-letter yang tahan lama dan
 * terlihat oleh operator, alih-alih sekadar melewatinya.
 *
 * Idempotent per `(chain_tx, log_index)` sehingga pemrosesan ulang tidak
 * menduplikasi catatan.
 */
export async function recordDeadLetter(input: {
  chainTx: string;
  logIndex: number;
  /** bytes32 project id onchain (hex) untuk konteks; bukan id internal. */
  projectId?: string | null;
  payer?: string | null;
  token?: string | null;
  amountRaw?: string | null;
  error: string;
  attempts?: number;
}): Promise<void> {
  await db
    .insert(depositDeadLetters)
    .values({
      id: newId("dlq"),
      chainTx: input.chainTx,
      logIndex: input.logIndex,
      projectId: input.projectId ?? null,
      payer: input.payer ?? null,
      token: input.token ?? null,
      amountRaw: input.amountRaw ?? null,
      error: input.error,
      attempts: input.attempts ?? 0,
    })
    .onConflictDoNothing({ target: [depositDeadLetters.chainTx, depositDeadLetters.logIndex] });
}

/** Dead-letter dari sebuah event deposit (dipakai jalur indexer). */
export function deadLetterFromEvent(
  event: DepositEvent,
  error: unknown,
  attempts: number,
): Promise<void> {
  return recordDeadLetter({
    chainTx: event.chainTx,
    logIndex: event.logIndex,
    projectId: event.projectId,
    payer: event.payer,
    token: event.token,
    amountRaw: event.amountRaw.toString(),
    error: error instanceof Error ? error.message : String(error),
    attempts,
  });
}
