import type { QueryClient } from "@tanstack/react-query";

/**
 * Cache yang isinya milik satu project (akun).
 *
 * Setiap key ini WAJIB memuat `projectId` sebagai salah satu elemennya
 * (mis. `["balance", projectId]`). Dengan begitu data dua wallet berbeda tidak
 * pernah bertukar key, dan sisa data akun lama bisa dibuang saat identitas sesi
 * berubah.
 *
 * `recipes` TIDAK ikut: isinya konfigurasi global backend (katalog formasi +
 * harga dari `recipes.yaml`), sama untuk semua project — lihat
 * `backend/src/routes/recipes.ts`. Key publik lain (`deposit-config`, `burns`)
 * juga sengaja dibiarkan.
 */
export const ACCOUNT_QUERY_ROOTS = [
  "project",
  "balance",
  "keys",
  "conversations",
  "conversation",
  "usage",
  "run",
] as const;

const ACCOUNT_ROOTS: ReadonlySet<string> = new Set(ACCOUNT_QUERY_ROOTS);

/**
 * Buang cache akun yang bukan milik `projectId` (identitas sesi saat ini).
 *
 * Dipanggil setiap identitas sesi berubah — logout, login wallet lain, atau
 * ganti akun di wallet — supaya data wallet lama tidak pernah dirender atau
 * dipakai ulang untuk wallet baru. Query yang memang milik identitas aktif
 * (atau key publik non-akun) dibiarkan.
 *
 * Karena dijalankan dari efek setelah render, observer sudah pindah ke key
 * identitas baru, sehingga query lama yang dibuang sudah tidak aktif — tidak
 * ada refetch yang sia-sia.
 */
export function clearStaleAccountQueries(
  client: QueryClient,
  projectId: string | null | undefined,
): void {
  client.removeQueries({
    predicate: (query) => {
      const [root] = query.queryKey;
      if (typeof root !== "string" || !ACCOUNT_ROOTS.has(root)) return false;
      return !query.queryKey.includes(projectId);
    },
  });
}
