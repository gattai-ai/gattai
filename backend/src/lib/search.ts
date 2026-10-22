/**
 * Pencarian substring untuk endpoint daftar percakapan (`GET /v1/conversations?q=`).
 *
 * `%`, `_`, dan `\` adalah wildcard/escape di `ILIKE`. Tanpa pelolosan, `%` yang
 * diketik user akan mencocokkan SEMUA baris (bukan mencari karakter persen), jadi
 * pola harus dibangun dari nilai yang sudah diloloskan.
 */

/** Batas panjang query pencarian; sisanya dipotong agar pola tetap kecil. */
export const SEARCH_MAX = 100;

/** Loloskan wildcard `LIKE`/`ILIKE` dengan backslash (dipakai bersama `ESCAPE '\'`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Ubah query mentah menjadi pola `ILIKE` `%...%`, atau `null` bila kosong.
 *
 * Dipangkas dan dipotong `SEARCH_MAX` karakter supaya pola yang dikirim ke DB
 * terbatas, lalu dibungkus `%` untuk pencarian substring.
 */
export function readSearchPattern(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return `%${escapeLike(trimmed.slice(0, SEARCH_MAX))}%`;
}
