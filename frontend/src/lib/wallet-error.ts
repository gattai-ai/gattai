/**
 * Sanitasi pesan error wallet sebelum ditampilkan ke pengguna.
 *
 *viem/wagmi melempar error yang sangat panjang: calldata, alamat kontrak,
 * nama fungsi, signature transaction, sampai string versi. Semuanya tidak
 * berguna bagi pengguna biasa dan bisa meluber keluar dari container.
 *
 * Aturan:
 *  1. Penolakan oleh pengguna (user reject) → pesan netral, bukan merah.
 *  2. Pola umum (wallet terputus, jaringan salah, saldo kurang) → pesan
 *     pendek yang bisa dikontrol.
 *  3. Sisanya → judul error asli, dipotong, tanpa payload teknis.
 */

/** Pesan netral untuk penolakan pengguna (tidak merah, tidak error). */
export const USER_REJECTED_MESSAGE = "Cancelled.";

/** Panjang maksimum pesan yang boleh tampil. */
const MAX_LENGTH = 180;

/**
 * Pesan yang masih berguna untuk ditampilkan setelah nama library dihapus.
 * Dipakai sebagai filter: kalau pesan memuat salah satu pola ini, tampilkan
 * versi ringkas yang ditulis tangan.
 */
const FRIENDLY: Array<{ test: RegExp; message: string }> = [
  { test: /user (rejected|denied|declined)/i, message: USER_REJECTED_MESSAGE },
  { test: /rejected the request/i, message: USER_REJECTED_MESSAGE },
  { test: /user denied/i, message: USER_REJECTED_MESSAGE },
  { test: /request rejected/i, message: USER_REJECTED_MESSAGE },
  { test: /user closed/i, message: USER_REJECTED_MESSAGE },
  { test: /transaction (rejected|declined)/i, message: USER_REJECTED_MESSAGE },
  { test: /insufficient funds/i, message: "Not enough funds in your wallet." },
  { test: /exceeds balance|balance too low/i, message: "Not enough funds in your wallet." },
  { test: /wallet.*(not connected|disconnected)/i, message: "Wallet disconnected. Reconnect to continue." },
  { test: /no wallet|connector not found/i, message: "No wallet detected." },
  { test: /network.*(unsupported|switch|changed)|unrecognized chain/i, message: "Wrong network. Switch to the correct network." },
  { test: /chain \d+ does not support/i, message: "Wrong network. Switch to the correct network." },
  { test: /timeout|timed out/i, message: "Request timed out. Try again." },
  { test: /nonce (too low|already)|replacement transaction underpriced/i, message: "Transaction is pending. Wait a moment and try again." },
  { test: /could not (establish|connect)|failed to fetch|fetch failed/i, message: "Could not reach the server. Check your connection." },
  { test: /unauthorized|401/i, message: "Session expired. Sign in again." },
  { test: /payment required|402/i, message: "Out of credits. Top up to continue." },
];

/** Nama kelas/kunci error viem yang menandakan penolakan pengguna. */
const REJECTION_NAMES = new Set([
  "UserRejectedRequestError",
  "UserDeniedRequestError",
  "TransactionRejectedRpcError",
  "RejectedError",
]);

/**
 * Ambil nama error dari berbagai bentuk: `Error.name`, viem nested cause, atau
 * kode numerik.viem membungkus error asli di `cause`, jadi telusuri satu
 * tingkat.
 */
function errorChain(cause: unknown): unknown[] {
  const chain: unknown[] = [cause];
  let current = cause;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current !== "object" || current === null) break;
    const next = (current as { cause?: unknown }).cause;
    if (!next || chain.includes(next)) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

function isUserRejected(cause: unknown): boolean {
  for (const link of errorChain(cause)) {
    if (typeof link !== "object" || link === null) continue;
    const { name, shortMessage, message, code } = link as {
      name?: unknown;
      shortMessage?: unknown;
      message?: unknown;
      code?: unknown;
    };
    if (typeof name === "string" && REJECTION_NAMES.has(name)) return true;
    if (code === 4001) return true;
    const text = [shortMessage, message]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    if (text && /user (rejected|denied|declined)|rejected the request|transaction rejected/i.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Buang detail teknis yang tidak perlu: calldata, alamat mentah, nama fungsi
 * yang/snama, signature transaction, dan jejak stack.
 */
function stripTechnicalDetail(text: string): string {
  return (
    text
      // signature tx
      .replace(/\b0x[0-9a-f]{80,}\b/gi, "")
      // alamat 0x... (40 hex) atau apa pun berawalan 0x panjang
      .replace(/\b0x[0-9a-f]{6,}\b/gi, "")
      // nama fungsi berparensesis panjang
      .replace(/\b\w+\([^)]*\)/g, "")
      // "Version: viem@x.x.x" dan semacamnya
      .replace(/\bVersion:[^\s]+/gi, "")
      // sisa spasi berlebih
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

/**
 * Ubah error apa pun menjadi pesan singkat yang aman tampil.
 * Selalu mengembalikan string non-kosong.
 */
export function walletErrorMessage(cause: unknown, fallback = "Something went wrong. Try again."): string {
  if (cause === null || cause === undefined) return fallback;

  if (isUserRejected(cause)) return USER_REJECTED_MESSAGE;

  // Cari pesan terbaik di rantai error.
  let raw = "";
  for (const link of errorChain(cause)) {
    if (typeof link === "string") {
      raw = link;
      break;
    }
    if (typeof link !== "object" || link === null) continue;
    const { shortMessage, message } = link as { shortMessage?: unknown; message?: unknown };
    if (typeof shortMessage === "string" && shortMessage.trim()) {
      raw = shortMessage;
      break;
    }
    if (typeof message === "string" && message.trim()) {
      raw = message;
      break;
    }
  }

  if (!raw) {
    if (typeof cause === "string") raw = cause;
    else if (typeof cause === "number" || typeof cause === "boolean") raw = String(cause);
    else return fallback;
  }

  for (const rule of FRIENDLY) {
    if (rule.test.test(raw)) return rule.message;
  }

  const cleaned = stripTechnicalDetail(raw);
  if (!cleaned) return fallback;
  if (cleaned.length <= MAX_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_LENGTH - 1).trimEnd()}…`;
}

/** True bila error adalah penolakan pengguna (untuk disembunyikan sepenuhnya). */
export function isUserRejection(cause: unknown): boolean {
  return isUserRejected(cause);
}