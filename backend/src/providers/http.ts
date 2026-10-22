import { env } from "../env";

/**
 * `fetch` dengan retry + timeout untuk seluruh adapter provider.
 *
 * Kebijakan:
 *   - Retry pada error jaringan, timeout, dan status transien (408/409/425/429/5xx).
 *   - Backoff eksponensial dengan jitter.
 *   - `AbortSignal` eksternal (mis. run dibatalkan) tidak pernah di-retry.
 *
 * Retry hanya menyentuh permintaan HTTP awal. Untuk streaming, retry terjadi
 * sebelum body dibaca (status non-ok), sehingga tidak menggandakan output.
 */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 8_000;
const BASE_BACKOFF_MS = 400;

export interface RetryOptions {
  /** Nama provider untuk pesan error. */
  label: string;
  signal?: AbortSignal;
  attempts?: number;
  timeoutMs?: number;
}

function backoffMs(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<Response> {
  const attempts = opts.attempts ?? env.providerRetryAttempts;
  const timeoutMs = opts.timeoutMs ?? env.providerTimeoutMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = setTimeout(
      () => controller.abort(new Error(`${opts.label} timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });

      if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
        // Buang body agar koneksi tidak menggantung sebelum retry.
        await response.body?.cancel().catch(() => {});
        lastError = new Error(`${opts.label} responded ${response.status} (attempt ${attempt})`);
        await sleep(backoffMs(attempt), opts.signal);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      // Jangan retry bila dibatalkan pemanggil.
      if (attempt < attempts && !opts.signal?.aborted) {
        await sleep(backoffMs(attempt), opts.signal);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${opts.label} failed after ${attempts} attempts`);
}
