import type { PublicClient } from "viem";
import { ApiError } from "../lib/http";
import { microToCredits } from "../lib/money";
import { isReceiptNotFound } from "./errors";
import { type DepositEvent, type IngestConfig, type IngestOutcome } from "./ingest";
import { normalizeOnchainId } from "./project-id";
import { decodeDepositEvents, hasEnoughConfirmations } from "./tx";

/**
 * Inti jalur "confirm" instan: memproses satu transaksi deposit onchain
 * yang **sudah diketahui user** langsung dari receipt-nya, tanpa menunggu
 * siklus pemindaian indexer.
 *
 * Fungsi ini memakai ulang `ingestDeposit` (jalur tulis yang sama, idempoten),
 * jadi aman tumpang-tindih dengan reconciler latar belakang.
 */

export type ConfirmStatus =
  | "credited"
  | "duplicate"
  | "pending"
  | "over_cap"
  | "dust"
  | "unpriced"
  | "unknown_token";

/** Bentuk respons API (snake_case) yang dikembalikan endpoint confirm. */
export interface ConfirmResult {
  status: ConfirmStatus;
  tx_hash: string;
  /** Credits yang baru ditambahkan pada panggilan ini (0 untuk duplicate). */
  credits_added?: number;
  /** Saldo credits project setelah pemrosesan. */
  balance_credits?: number;
  usd_value?: string;
  reason?: string;
}

export interface ConfirmDeps {
  client: Pick<PublicClient, "getTransactionReceipt" | "getBlockNumber">;
  depositManager: string;
  confirmations: number;
  config: IngestConfig;
  projectId: string;
  projectOnchainId: string | null;
  ingest: (event: DepositEvent, config: IngestConfig) => Promise<IngestOutcome>;
  getBalanceMicro: (projectId: string) => Promise<number>;
}

/**
 * Proses tx `txHash` untuk `projectId`.
 *
 * - `pending` bila receipt belum ada / konfirmasi belum cukup (HTTP 202).
 * - Melempar `ApiError` untuk kesalahan yang tak bisa dikreditkan
 *   (NO_DEPOSIT_LOG 400, NOT_YOUR_DEPOSIT 403, RPC_UPSTREAM 502).
 */
export async function confirmDeposit(txHash: string, deps: ConfirmDeps): Promise<ConfirmResult> {
  if (!deps.projectOnchainId) {
    throw new ApiError(409, "PROJECT_NOT_READY", "Project does not have an onchain id yet.");
  }

  const receipt = await readReceipt(deps, txHash);
  if (!receipt) return { status: "pending", tx_hash: txHash };

  const events = decodeDepositEvents(receipt, deps.depositManager);
  if (events.length === 0) {
    throw new ApiError(
      400,
      "NO_DEPOSIT_LOG",
      "Transaction does not contain a deposit event for DepositManager.",
    );
  }

  const expected = normalizeOnchainId(deps.projectOnchainId);
  if (events.some((event) => normalizeOnchainId(event.projectId) !== expected)) {
    throw new ApiError(
      403,
      "NOT_YOUR_DEPOSIT",
      "This deposit does not belong to the current session.",
    );
  }

  const head = await readHead(deps);
  if (!hasEnoughConfirmations(receipt.blockNumber, head, deps.confirmations)) {
    return { status: "pending", tx_hash: txHash };
  }

  let last: IngestOutcome | undefined;
  let creditsAddedMicro = 0;
  for (const event of events) {
    const outcome = await deps.ingest(event, deps.config);
    last = outcome;
    if (outcome.status === "credited") creditsAddedMicro += outcome.creditsMicro;
  }

  const balanceMicro = await deps.getBalanceMicro(deps.projectId);
  // Satu tx bisa berisi beberapa event (mis. batch deposit). Status event
  // terakhir tidak boleh menyembunyikan kredit yang sudah masuk dari event
  // sebelumnya.
  if (creditsAddedMicro > 0) {
    return {
      status: "credited",
      tx_hash: txHash,
      credits_added: microToCredits(creditsAddedMicro),
      balance_credits: microToCredits(balanceMicro),
    };
  }
  return mapOutcome(txHash, last!, creditsAddedMicro, microToCredits(balanceMicro));
}

async function readReceipt(deps: ConfirmDeps, txHash: string) {
  try {
    return await deps.client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch (error) {
    // Belum masuk blok = pending, bukan gangguan RPC. Frontend akan poll lagi.
    if (isReceiptNotFound(error)) return null;
    throw new ApiError(502, "RPC_UPSTREAM", "Could not read the transaction receipt from the chain.");
  }
}

async function readHead(deps: ConfirmDeps): Promise<bigint> {
  try {
    return await deps.client.getBlockNumber();
  } catch {
    throw new ApiError(502, "RPC_UPSTREAM", "Could not read the latest block number from the chain.");
  }
}

function mapOutcome(
  txHash: string,
  outcome: IngestOutcome,
  creditsAddedMicro: number,
  balanceCredits: number,
): ConfirmResult {
  switch (outcome.status) {
    case "credited":
      return {
        status: "credited",
        tx_hash: txHash,
        credits_added: microToCredits(creditsAddedMicro),
        balance_credits: balanceCredits,
      };
    case "duplicate":
      return { status: "duplicate", tx_hash: txHash, credits_added: 0, balance_credits: balanceCredits };
    case "over_cap":
      return { status: "over_cap", tx_hash: txHash, usd_value: outcome.usdValue };
    case "dust":
      return { status: "dust", tx_hash: txHash, usd_value: outcome.usdValue };
    case "unpriced":
      return { status: "unpriced", tx_hash: txHash, reason: outcome.reason };
    case "unknown_token":
      return { status: "unknown_token", tx_hash: txHash };
    default:
      // `unknown_project` tak mungkin di sini (kepemilikan sudah diverifikasi),
      // tetapi bila terjadi, tolak sebagai bukan milik caller.
      throw new ApiError(403, "NOT_YOUR_DEPOSIT", "Project in the event does not match.");
  }
}
