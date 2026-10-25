import { ApiError } from "./api";
import { walletErrorMessage } from "./wallet-error";

/**
 * Terjemahan pesan/kode backend menjadi kalimat yang ramah untuk pengguna.
 *
 * Prinsipnya: **kode mentah backend tidak pernah ditampilkan apa adanya**.
 * Kesalahan teknis (mis. `INSUFFICIENT_BALANCE`, `RATE_LIMITED`) dipetakan ke
 * kalimat Inggris yang bisa dimengerti; bila tidak ada padanan, pakai pesan
 * yang ditulis server (sudah bahasa Inggris & manusiawi), dan hanya kalau itu
 * pun kosong baru pakai `fallback`.
 */

/** Panjang maksimum pesan yang boleh tampil (cegah pesan server yang sangat panjang). */
const MAX_LENGTH = 200;

/** Padanan ramah per kode error backend (`error.code`). */
const CODE_MESSAGES: Record<string, string> = {
  // Saldo & kuota.
  INSUFFICIENT_BALANCE: "Not enough credits for this run. Top up to continue.",
  TRIAL_EXHAUSTED: "You have used all your free prompts. Top up to keep going.",
  TRIAL_ATTEMPTS_EXHAUSTED: "Free trial attempts are used up. Top up to keep going.",
  TRIAL_MEDIA_EXHAUSTED:
    "Your free media runs are used up. Text prompts are still free — top up to run this formation.",
  // Kuota holder (free runs berbasis tier $GATTAI).
  HOLDER_BUDGET_EXHAUSTED:
    "Today's holder free-run budget is used up. Top up to continue, or try again after 00:00 UTC.",
  HOLDER_QUOTA_EXHAUSTED:
    "You've used today's holder free-run quota. Top up to continue, or come back after 00:00 UTC.",
  HOLDER_RUNS_PAUSED:
    "Holder free runs are temporarily paused. Top up to continue while we finish maintenance.",
  // Autentikasi & izin.
  UNAUTHORIZED: "Your session expired. Sign in again.",
  SIWE_INVALID: "Sign-in could not be verified. Try again.",
  // Percakapan.
  CONVERSATION_NOT_FOUND: "That chat no longer exists.",
  CONVERSATION_ID_TAKEN:
    "That chat is no longer available. Send your prompt again to start a new one.",
  CONVERSATION_ACTIVE: "This chat has a run in progress. Wait for it to finish.",
  CONVERSATION_CREATE_FAILED: "Something went wrong opening the chat. Try again.",
  // Run & formasi.
  RUN_NOT_FOUND: "That run no longer exists.",
  RECIPE_NOT_FOUND: "That formation isn't available right now.",
  RECIPE_SYNC_FAILED: "Something went wrong on our side. Try again shortly.",
  RUN_CREATE_FAILED: "Something went wrong starting the run. Try again.",
  CONFIRMATION_REQUIRED: "This formation needs a cost confirmation before it can run.",
  // Input & laju.
  VALIDATION_ERROR: "Please check your input and try again.",
  BAD_REQUEST: "Please check your input and try again.",
  INVALID_CURSOR: "That page of history is no longer valid. Reload to continue.",
  RATE_LIMITED: "You're going a bit fast. Wait a moment and try again.",
  REQUEST_TOO_LARGE: "This request is too large. Shorten the prompt or history and try again.",
  IDEMPOTENCY_CONFLICT: "That request was already sent with different content. Try again.",
  // Umum.
  MODEL_NOT_FOUND: "That model isn't available right now.",
  PROJECT_NOT_READY: "Your project isn't ready yet. Try again in a moment.",
  RPC_UPSTREAM: "The network is busy. Try again in a moment.",
  // Kegagalan run (`runs.error` / `run_steps.error`). Backend hanya menyimpan
  // pesan publik; padanan ini menjaga copy tetap konsisten di UI.
  PROVIDER_NOT_CONFIGURED:
    "This formation is temporarily unavailable. Please try again later.",
  PROVIDER_ERROR: "The model provider could not complete this step. Please try again.",
  RUN_FAILED: "Something went wrong while running this formation. Please try again.",
  RUN_LIMIT_REACHED: "This request exceeded the limit for a single run. Try a shorter prompt.",
};

/** Padanan ramah per status HTTP bila kode tidak dipetakan. */
function statusMessage(status: number): string | null {
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 402) return "Not enough credits for this run. Top up to continue.";
  if (status === 403) return "You don't have access to this.";
  if (status === 404) return "That item no longer exists.";
  if (status === 413) return "This request is too large. Shorten the prompt or history and try again.";
  if (status === 429) return "You're going a bit fast. Wait a moment and try again.";
  if (status >= 500) return "Something went wrong on our side. Try again shortly.";
  return null;
}

function clamp(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Pesan ramah untuk error apa pun. Selalu mengembalikan string non-kosong dan
 * tidak pernah menampilkan prefiks kode mentah (`KODE: pesan`).
 */
export function errorMessage(cause: unknown, fallback = "Something went wrong. Try again."): string {
  let message: string;
  if (cause instanceof ApiError) {
    const known = CODE_MESSAGES[cause.code] ?? statusMessage(cause.status);
    message = known ?? (clamp(cause.message) || fallback);
  } else {
    // Bukan error API (mis. `fetch` gagal / error wallet) → sanitasi standar.
    message = walletErrorMessage(cause, fallback);
  }
  // Jaring pengaman terakhir: detail internal (nama env, nama provider, stack,
  // path berkas) tidak boleh tampil di layar mana pun (Chat, History, AppShell,
  // Balance, dsb).
  return sanitizeInternalText(message) ?? fallback;
}

/**
 * Hapus penyebutan provider internal dari teks yang tampil ke pengguna.
 *
 * Routing, log, dan database tetap memakai nama provider asli; hanya UI yang
 * menampilkan label formasi (GPT/Claude/etc). Pola ini juga menangkap nama
 * model seperti `mimo-v2.6-flash`.
 */
const INTERNAL_PROVIDER_PATTERN = /\bmimo(?:-[a-z0-9._-]+)?/gi;

/**
 * Pola detail internal yang tidak boleh sampai ke layar. Regex tanpa flag `g`
 * supaya aman dipakai berulang dengan `.test()`.
 */
const INTERNAL_TEXT_PATTERNS: RegExp[] = [
  /\benvironment variable\b/i,
  // NAMA_VARIABEL_ENV / enum mentah backend.
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+/,
  // Nama provider internal (label publik "Claude"/"GPT" tetap boleh tampil).
  /\b(anthropic|openai|perplexity|higgsfield)\b/i,
  // Frame stack trace.
  /\bat\s+\S+\s*\(/,
  // Nama kelas error library & detail Postgres.
  /\b(SQLSTATE|pg_|drizzle|TypeError|ReferenceError|SyntaxError)\b/i,
  // Path berkas (Windows/Unix).
  /[A-Za-z]:\\|\/(?:home|app|usr|var)\//,
  /\bError:/,
  // Frasa diagnostik internal (termasuk sisa pesan berbahasa Indonesia yang
  // tersimpan sebelum kontrak pesan publik dipasang).
  /\b(tidak dikenal|tidak ditemukan|tidak valid|belum diisi|melewati|membutuhkan|merespons|wajib)\b/i,
  /\b(unknown provider|model ref not found|invalid media spec)\b/i,
];

export function sanitizeProviderMentions(message: string | null): string | null {
  if (!message) return message;
  return message.replace(INTERNAL_PROVIDER_PATTERN, "the model");
}

/**
 * Versi luas dari `sanitizeProviderMentions`: selain nama provider/model, teks
 * yang masih memuat detail internal dianggap tidak aman → `null`, sehingga
 * pemanggil memakai fallback yang ramah.
 */
export function sanitizeInternalText(message: string | null): string | null {
  if (!message) return message;
  const cleaned = sanitizeProviderMentions(message);
  if (cleaned === null) return null;
  if (INTERNAL_TEXT_PATTERNS.some((pattern) => pattern.test(cleaned))) return null;
  return cleaned;
}

/** Label ramah untuk badge status run (menggantikan enum mentah backend). */
const STATUS_LABELS: Record<string, string> = {
  CREATED: "RUNNING",
  RESERVED: "RUNNING",
  RUNNING: "RUNNING",
  AWAITING_CONFIRMATION: "NEEDS CONFIRM",
  SETTLED: "DONE",
  RELEASED: "FAILED",
  INSUFFICIENT_BALANCE: "NO CREDITS",
  ERROR: "FAILED",
  CAP_REACHED: "CAP REACHED",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

/**
 * Tautan top-up dari badan error 402 (`topup_url`), hanya bila berupa path
 * relatif sehingga tidak bisa dipakai mengarahkan ke situs luar.
 */
export function topupHref(cause: unknown): string | null {
  if (!(cause instanceof ApiError)) return null;
  const url = cause.extra?.topup_url;
  return typeof url === "string" && url.startsWith("/") ? url : null;
}
