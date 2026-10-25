/**
 * Klien API GATTAI.
 *
 * Base URL: VITE_API_URL bila diisi, jika tidak "/api" (di dev Vite mem-proxy
 * "/api" ke backend; di produksi rewrite Vercel meneruskan "/api/*" ke backend).
 *
 * Base default sengaja relatif supaya frontend dan API same-origin: cookie sesi
 * SIWE dipasang `SameSite=Lax`, jadi hanya terkirim pada origin yang sama.
 * `credentials: "include"` tetap dipakai agar cookie ikut pada permintaan itu.
 */

/**
 * Normalisasi base URL API.
 *
 * Nilai kosong/whitespace (mis. build lama yang mengisi `VITE_API_URL=""`)
 * BUKAN nullish, jadi `?? "/api"` tidak cukup. Tanpa normalisasi ini frontend
 * memanggil `/auth/nonce` (bukan `/api/auth/nonce`) dan Caddy mengembalikan
 * HTML SPA. `deploy.sh` sekarang memaksa `/api`, tetapi helper ini tetap
 * defensif untuk build/dev yang tidak mengisi variabel tersebut.
 */
export function resolveApiBase(raw: string | undefined): string {
  const trimmed = raw?.trim();
  return trimmed?.replace(/\/+$/, "") || "/api";
}

const API_BASE = resolveApiBase(import.meta.env.VITE_API_URL as string | undefined);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Field tambahan dari badan error (mis. `topup_url`, `trial`). */
  readonly extra?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

interface ApiFetchOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = "GET", body, headers, signal } = options;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!response.ok) {
    let code = "HTTP_ERROR";
    let message = `Request failed (${response.status})`;
    let extra: Record<string, unknown> | undefined;
    try {
      const parsed = (await response.json()) as {
        error?: { code?: string; message?: string; [key: string]: unknown };
      };
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
      if (parsed.error) {
        // Simpan field tambahan (mis. `topup_url`) tanpa `code`/`message`.
        extra = { ...parsed.error };
        delete extra.code;
        delete extra.message;
      }
    } catch {
      // Respons bukan JSON; pakai pesan default.
    }
    throw new ApiError(response.status, code, message, extra);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** URL absolut untuk fetch non-JSON (mis. EventSource). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
