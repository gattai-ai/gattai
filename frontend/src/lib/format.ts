/** Pemformat tampilan untuk tanggal dan alamat. */

/**
 * Tanggal + jam ringkas, berbahasa Inggris (mis. `Oct 18, 9:04 AM`).
 *
 * Satu-satunya pemformat tanggal untuk daftar: dipakai halaman History dan
 * ledger Usage. Nilai kosong/tidak valid → `-` supaya kolom tidak pernah kosong
 * tanpa alasan yang jelas.
 */
export function formatShortDateTime(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Waktu relatif singkat untuk tabel yang banyak berisi waktu dekat (mis.
 * `just now`, `5m ago`, `3h ago`), jatuh ke `formatShortDateTime` bila lebih dari
 * sehari. Waktu masa depan tetap dibaca `just now` (bukan `-Nm ago`).
 */
export function formatRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return formatShortDateTime(date);
}

export function shortenAddress(address: string | null | undefined, size = 4): string {
  if (!address) return "-";
  if (address.length <= size * 2 + 3) return address;
  return `${address.slice(0, size + 2)}…${address.slice(-size)}`;
}
