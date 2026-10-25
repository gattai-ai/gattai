/**
 * Batas waktu generik untuk operasi async yang tidak boleh menggantung.
 *
 * Dipakai jalur holder: RPC bisa lambat/health-check menggantung, dan endpoint
 * status tidak boleh menahan request selama timeout RPC default (15 detik).
 * Promise asli tetap berjalan; hasilnya diabaikan setelah timeout.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = "operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
