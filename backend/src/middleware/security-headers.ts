import type { MiddlewareHandler } from "hono";

/**
 * Header keamanan tingkat API + larangan cache untuk respons berisi identitas.
 *
 * HSTS, CSP, dan `X-Frame-Options` untuk halaman web diatur di origin frontend
 * (`frontend/vercel.json`) — di situlah dokumen HTML dirender dan XSS relevan.
 * Di sini fokusnya: jangan pernah biarkan proksi/cache menyimpan respons
 * terautentikasi, dan jangan biarkan browser menebak tipe konten.
 *
 * `/v1/public/*` (burns, konfigurasi deposit) sengaja dikecualikan: data publik
 * boleh di-cache dan tidak mengandung identitas.
 *
 * Header dipasang **sebelum** `next()` supaya respons error (mis. 401 dari
 * `/auth/me`) ikut membawanya — kode setelah `next()` dilewati saat handler
 * melempar, sedangkan header yang sudah disiapkan tetap diterapkan.
 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");

  const path = c.req.path;
  const isPrivate =
    path.startsWith("/auth/") || (path.startsWith("/v1/") && !path.startsWith("/v1/public/"));
  if (isPrivate) {
    c.header("Cache-Control", "no-store, private");
  }

  await next();
};
