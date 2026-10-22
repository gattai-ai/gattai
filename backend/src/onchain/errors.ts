/**
 * Deteksi error "receipt tidak ditemukan" dari viem/RPC.
 *
 * Viem melempar `TransactionReceiptNotFoundError` saat tx belum masuk blok.
 * Ini BUKAN gangguan RPC: pada jalur confirm artinya masih pending, dan pada
 * penjaga reorg artinya tx bisa saja keluar dari rantai kanonik. Tanpa
 * pembedaan ini, keduanya diperlakukan sebagai error sementara dan deposit
 * yang benar-benar hilang tidak pernah ditandai.
 */
export function isReceiptNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const name = (error as { name?: unknown }).name;
  if (name === "TransactionReceiptNotFoundError" || name === "TransactionNotFoundError") {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /transaction receipt.*not found|receipt.*could not be found|receipt.*not found/i.test(
    message,
  );
}
