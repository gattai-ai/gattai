/**
 * Kontrak error publik untuk run.
 *
 * Prinsip: teks internal — nama environment variable, body respons provider,
 * pesan library, stack trace — **tidak pernah** sampai ke pengguna. Yang
 * disimpan di `runs.error` / `run_steps.error` dan yang dikirim lewat SSE
 * hanyalah pesan publik berbahasa Inggris; detail mentah hanya masuk log server
 * (lihat `internalErrorDetail`).
 */

import { MissingEnvError } from "../env";

export type PublicRunErrorCode =
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_ERROR"
  | "RUN_FAILED"
  | "RUN_LIMIT_REACHED";

export interface PublicRunError {
  code: PublicRunErrorCode;
  message: string;
}

/** Pesan publik per kode. Satu sumber kebenaran, dipakai backend & dipetakan frontend. */
const MESSAGES: Record<PublicRunErrorCode, string> = {
  PROVIDER_NOT_CONFIGURED:
    "This formation is temporarily unavailable. Please try again later.",
  PROVIDER_ERROR: "The model provider could not complete this step. Please try again.",
  RUN_FAILED: "Something went wrong while running this formation. Please try again.",
  RUN_LIMIT_REACHED: "This request exceeded the limit for a single run. Try a shorter prompt.",
};

/** Nilai yang dipakai bila teks tersimpan terbukti membocorkan detail internal. */
export const GENERIC_RUN_ERROR = MESSAGES.RUN_FAILED;

/**
 * Kegagalan di adapter provider. `message` sudah aman tampil; detail mentah
 * (body respons, status HTTP, nama provider internal) disimpan terpisah untuk
 * log — jangan pernah ikut dikirim ke klien.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly detail?: string;

  constructor(message: string, options: { provider: string; status?: number; detail?: string }) {
    super(message);
    this.name = "ProviderError";
    this.provider = options.provider;
    this.status = options.status;
    this.detail = options.detail;
  }
}

/** Error adapter dengan pesan publik standar. */
export function providerError(provider: string, status: number, detail: string): ProviderError {
  return new ProviderError(MESSAGES.PROVIDER_ERROR, { provider, status, detail });
}

/** Biaya aktual run melewati plafon yang dikonfigurasi. */
export class RunLimitReachedError extends Error {
  constructor() {
    super(MESSAGES.RUN_LIMIT_REACHED);
    this.name = "RunLimitReachedError";
  }
}

/** Error adapter tanpa status HTTP (mis. timeout polling job media async). */
export function providerFailure(provider: string, detail: string): ProviderError {
  return new ProviderError(MESSAGES.PROVIDER_ERROR, { provider, detail });
}

/**
 * Peta error apa pun → kode + pesan publik.
 *
 * Semua yang tidak dikenali jatuh ke `RUN_FAILED` (pesan generik), jadi tidak
 * ada jalur yang bisa membocorkan teks internal karena lupa dipetakan.
 */
export function toPublicRunError(error: unknown): PublicRunError {
  if (error instanceof MissingEnvError) {
    return { code: "PROVIDER_NOT_CONFIGURED", message: MESSAGES.PROVIDER_NOT_CONFIGURED };
  }
  if (error instanceof ProviderError) {
    return { code: "PROVIDER_ERROR", message: MESSAGES.PROVIDER_ERROR };
  }
  if (error instanceof RunLimitReachedError) {
    return { code: "RUN_LIMIT_REACHED", message: MESSAGES.RUN_LIMIT_REACHED };
  }
  return { code: "RUN_FAILED", message: MESSAGES.RUN_FAILED };
}

/** Detail mentah untuk log server (server logs boleh memuat teks internal). */
export function internalErrorDetail(error: unknown): string {
  if (error instanceof ProviderError) {
    const status = error.status != null ? ` ${error.status}` : "";
    return `${error.provider}${status}: ${error.detail ?? error.message}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Pola teks yang menandakan detail internal bocor ke kolom error (mis. baris
 * run lama yang tersimpan sebelum perbaikan ini). Regex tanpa flag `g` supaya
 * aman dipakai berulang dengan `.test()`.
 */
const INTERNAL_TEXT_PATTERNS: RegExp[] = [
  /\benvironment variable\b/i,
  // NAMA_VARIABEL_ENV / NAMA_ENUM_MENTAH yang seharusnya tidak pernah tampil.
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+/,
  // Nama provider internal (label publik seperti "Claude"/"GPT" tetap boleh).
  /\b(anthropic|openai|perplexity|higgsfield|mimo)\b/i,
  // Frame stack trace.
  /\bat\s+\S+\s*\(/,
  // Nama kelas/error library & detail Postgres.
  /\b(SQLSTATE|pg_|drizzle|TypeError|ReferenceError|SyntaxError)\b/i,
  // Path berkas (Windows/Unix).
  /[A-Za-z]:\\|\/(?:home|app|usr|var)\//,
  /\bError:/,
  // Frasa diagnostik internal (termasuk sisa pesan berbahasa Indonesia yang
  // sempat tersimpan sebelum kontrak ini).
  /\b(tidak dikenal|tidak ditemukan|tidak valid|belum diisi|melewati|membutuhkan|merespons|wajib)\b/i,
  /\b(unknown provider|model ref not found|invalid media spec)\b/i,
];

/** Panjang maksimum teks error yang dianggap wajar untuk ditampilkan. */
const MAX_STORED_ERROR_LENGTH = 300;

/**
 * Bersihkan teks error yang **sudah tersimpan** di DB (termasuk baris lama).
 * Teks yang memuat pola internal diganti pesan generik; teks aman dibiarkan.
 */
export function sanitizeStoredError(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_STORED_ERROR_LENGTH) return GENERIC_RUN_ERROR;
  if (INTERNAL_TEXT_PATTERNS.some((pattern) => pattern.test(trimmed))) return GENERIC_RUN_ERROR;
  return trimmed;
}
