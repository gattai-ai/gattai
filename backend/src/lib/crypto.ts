import {
  createHmac,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { env } from "../env";

/**
 * API key disimpan sebagai hash (scrypt + salt acak). Key lengkap hanya
 * ditampilkan sekali kepada pengguna dan tidak pernah disimpan plaintext.
 */

const API_KEY_PREFIX = "gtt_live_";
const KEY_BYTES = 24;

export const API_KEY_PREFIX_LENGTH = API_KEY_PREFIX.length;

export interface GeneratedApiKey {
  /** Key lengkap, hanya dikembalikan sekali. */
  secret: string;
  /** Potongan awal untuk ditampilkan di UI. */
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const body = randomBytes(KEY_BYTES).toString("hex");
  const secret = `${API_KEY_PREFIX}${body}`;
  // Simpan potongan awal agar bisa ditampilkan tanpa membuka key penuh.
  const prefix = secret.slice(0, API_KEY_PREFIX.length + 8);
  return { secret, prefix };
}

export function isApiKeyFormat(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX) && value.length > API_KEY_PREFIX.length + 16;
}

/** Potongan awal key yang disimpan untuk pencarian & tampilan. */
export function apiKeyPrefix(secret: string): string {
  return secret.slice(0, API_KEY_PREFIX.length + 8);
}

export function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(secret, salt, 32).toString("hex");
  return `${salt}:${derived}`;
}

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

/**
 * Verifikasi key (async).
 *
 * scrypt memakan ~50–100 ms CPU; versi sinkron memblokir event loop di jalur
 * yang dieksekusi setiap request ber-API-key — pengali CPU untuk DoS. Versi
 * async menjaga loop tetap responsif. Pembuatan hash tetap sinkron
 * (`hashSecret`) karena hanya terjadi sekali saat key dibuat.
 */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [salt, derived] = stored.split(":");
  if (!salt || !derived) return false;
  const expected = Buffer.from(derived, "hex");
  const actual = await scryptAsync(secret, salt, 32);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ── Sesi (cookie bertanda tangan HMAC) ───────────────────────────────────────

export interface SessionPayload {
  projectId: string;
  address: string;
  /** ID baris `sessions` (jti) — otoritas sesi ada di DB, token hanya membawa rujukan. */
  sid: string;
  /** Unix ms kedaluwarsa. */
  exp: number;
  [key: string]: unknown;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signSession(payload: SessionPayload): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", env.sessionSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token: string): SessionPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", env.sessionSecret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
