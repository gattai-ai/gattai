import type { MiddlewareHandler } from "hono";
import { ApiError } from "../lib/http";
import { isAllowedOrigin } from "../lib/origins";

/**
 * Penjaga CSRF lapis kedua, independen dari `SameSite=Lax`.
 *
 * `SameSite=Lax` sudah menahan POST lintas-situs, tapi perilaku itu bergantung
 * pada atribut cookie & asumsi browser. Pemeriksaan `Origin`/`Sec-Fetch-Site`
 * mengunci hal yang sama di level API sehingga perubahan kebijakan cookie di
 * masa depan tidak diam-diam membuka CSRF.
 *
 * Aturan (hanya untuk metode yang mengubah state):
 *  - `Sec-Fetch-Site: cross-site` → tolak (browser modern selalu mengirimnya).
 *  - `Origin` ada tapi tak ada di daftar izin → tolak.
 *  - `Origin` absen → izinkan: klien non-browser (curl/SDK dengan API key)
 *    tidak mengirim `Origin`, dan memaksanya hanya merusak integrasi.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const csrfOriginGuard: MiddlewareHandler = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  if (c.req.header("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "CSRF_BLOCKED", "Cross-site request rejected.");
  }

  const origin = c.req.header("origin");
  if (origin && !isAllowedOrigin(origin)) {
    throw new ApiError(403, "CSRF_BLOCKED", "Origin not allowed.");
  }

  return next();
};
