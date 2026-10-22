import { decodeEventLog } from "viem";
import { DEPOSITED_EVENT } from "./client";
import type { DepositEvent } from "./ingest";
import type { Hex } from "./types";

/**
 * Helper murni untuk memproses satu transaksi deposit dari receipt-nya
 * (dipakai jalur "confirm" instan). Dipisah dari RPC/DB agar mudah dites.
 */

/** Bentuk log minimal yang dibutuhkan (kompatibel dengan `viem` receipt logs). */
export interface ReceiptLogLike {
  address: string;
  topics: readonly string[];
  data: string;
  transactionHash: string | null;
  logIndex: number | null;
}

/** Bentuk receipt minimal yang dibutuhkan. */
export interface ReceiptLike {
  blockNumber?: bigint | null;
  blockHash?: string | null;
  logs: readonly ReceiptLogLike[];
}

/**
 * Dekode semua event `Deposited` milik `depositManager` dari receipt.
 * Log alamat lain / event lain dilewati. Nol panggilan RPC tambahan.
 *
 * Metadata blok ikut dibawa ke setiap event: tanpa ini, deposit yang masuk
 * lewat jalur `confirm` tersimpan dengan `block_number = NULL` dan tidak
 * pernah diperiksa oleh penjaga reorg.
 */
export function decodeDepositEvents(
  receipt: Pick<ReceiptLike, "logs" | "blockNumber" | "blockHash">,
  depositManager: string,
): DepositEvent[] {
  const manager = depositManager.toLowerCase();
  const events: DepositEvent[] = [];

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== manager) continue;
    if (log.transactionHash === null || log.logIndex === null) continue;

    let decoded: ReturnType<typeof decodeEventLog>;
    try {
      decoded = decodeEventLog({
        abi: [DEPOSITED_EVENT],
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      // Bukan event `Deposited` (atau payload tak terduga) → lewati.
      continue;
    }

    const args = decoded.args as
      | { projectId?: Hex; payer?: Hex; token?: Hex; amount?: bigint }
      | undefined;
    if (
      decoded.eventName !== "Deposited" ||
      !args?.projectId ||
      !args.payer ||
      !args.token ||
      args.amount === undefined
    ) {
      continue;
    }

    events.push({
      chainTx: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: receipt.blockNumber ?? undefined,
      blockHash: receipt.blockHash ?? undefined,
      projectId: args.projectId,
      payer: args.payer,
      token: args.token,
      amountRaw: args.amount,
    });
  }

  return events;
}

/**
 * Apakah blok `blockNumber` sudah mencapai `required` konfirmasi relatif `head`.
 * Blok pada `head` sendiri = 1 konfirmasi.
 */
export function hasEnoughConfirmations(
  blockNumber: bigint | null,
  head: bigint,
  required: number,
): boolean {
  if (blockNumber === null) return false;
  const confirmations = head - blockNumber + 1n;
  const need = BigInt(Math.max(0, required));
  return confirmations >= need;
}
