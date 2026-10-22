/**
 * Helper media aman (tanpa komponen). Output run media berbentuk
 * `{ type, url } | null`; hanya URL https yang boleh dirender.
 */

export interface RunMedia {
  type: string;
  url: string;
}

/** Validasi ketat: string URL dengan skema https saja. */
export function isSafeMediaUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Ekstrak `{ type, url }` yang aman dari `output` run, atau null. */
export function extractMedia(output: unknown): RunMedia | null {
  if (typeof output !== "object" || output === null) return null;
  const media = (output as Record<string, unknown>).media;
  if (typeof media !== "object" || media === null) return null;
  const record = media as Record<string, unknown>;
  if (!isSafeMediaUrl(record.url)) return null;
  const type = typeof record.type === "string" ? record.type : "image";
  return { type, url: record.url };
}
