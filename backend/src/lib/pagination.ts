import { ApiError } from "./http";

/**
 * Penjaga paginasi bersama endpoint daftar/transkrip.
 *
 * Dipisah dari route supaya batas dan bentuk kursor bisa diuji langsung tanpa
 * menyiapkan ratusan baris hanya untuk melihat efek klem.
 */

/** Limit query yang aman: non-angka/≤0 → fallback, lalu diklem ke `max`. */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/**
 * Kursor pagination berbentuk `<ISO timestamp>|<id>`.
 *
 * Timestamp ikut dibawa (bukan hanya id) supaya halaman berikutnya tetap bisa
 * diambil walau baris kursor sudah terhapus — mis. run yang dibatalkan `cancel`
 * atau kedaluwarsa di tangan reaper.
 */
export function readCursor(raw: string | undefined): { at: Date; id: string } | null {
  if (raw === undefined || raw === "") return null;
  const separator = raw.lastIndexOf("|");
  const at = separator > 0 ? new Date(raw.slice(0, separator)) : new Date(Number.NaN);
  const id = separator > 0 ? raw.slice(separator + 1) : "";
  if (!id || Number.isNaN(at.getTime())) {
    throw new ApiError(400, "INVALID_CURSOR", "Invalid pagination cursor.");
  }
  return { at, id };
}
