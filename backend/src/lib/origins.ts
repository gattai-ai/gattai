import { isProd } from "../env";

/**
 * Daftar origin yang diizinkan memanggil API.
 *
 * Sumber tunggal untuk CORS (`app.ts`) dan penjaga CSRF (`middleware/origin.ts`)
 * supaya keduanya tidak pernah berbeda pendapat.
 */

/**
 * Urai `FRONTEND_URL` (dipisah koma) menjadi daftar origin.
 *
 * Di produksi **wajib** diisi dan **tidak boleh** memuat `*`: wildcard membuat
 * CORS merefleksikan origin mana pun, dan saat itu pula penjaga CSRF menjadi
 * no-op (`isAllowedOrigin` selalu true) — sementara cookie sesi tetap dikirim.
 * Kombinasi seperti `FRONTEND_URL="https://x,*"` karena itu tidak boleh lolos:
 * lebih baik gagal saat boot daripada diam-diam terbuka.
 *
 * Di luar produksi `*` tetap diizinkan agar dev/smoke test tidak perlu setelan.
 */
export function parseAllowedOrigins(raw: string | undefined, prod: boolean): string[] {
  const origins = (raw ?? "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (prod && (origins.length === 0 || origins.includes("*"))) {
    throw new Error(
      'FRONTEND_URL wajib diisi dengan origin frontend final (tanpa "*") saat NODE_ENV=production.',
    );
  }

  return origins;
}

export const allowedOrigins = parseAllowedOrigins(process.env.FRONTEND_URL, isProd());

/**
 * `credentials: true` hanya bila origin tidak wildcard. Browser menolak
 * kombinasi `*` + credentials, jadi wildcard otomatis berarti tanpa cookie.
 */
export const credentialsAllowed = allowedOrigins[0] !== "*";

/**
 * `true` bila `origin` boleh, menurut daftar `origins` mana pun.
 *
 * `origin` kosong = permintaan non-browser (curl/SDK) atau navigasi same-origin
 * yang tidak mengirim `Origin` → diizinkan. Daftar memuat `*` (hanya mungkin di
 * non-produksi) berarti meloloskan apa pun.
 */
export function originAllowed(origin: string | undefined | null, origins: string[]): boolean {
  if (!origin) return true;
  if (origins.includes("*")) return true;
  return origins.includes(origin);
}

/** `originAllowed` dengan daftar dari `FRONTEND_URL` (produksi). */
export function isAllowedOrigin(origin: string | undefined | null): boolean {
  return originAllowed(origin, allowedOrigins);
}
