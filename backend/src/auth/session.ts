import { and, eq, isNull, lt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { db } from "../db";
import { sessions } from "../db/schema";
import { isProd } from "../env";
import { newId } from "../lib/id";
import { ApiError } from "../lib/http";
import { signSession, verifySession, type SessionPayload } from "../lib/crypto";

/**
 * Sesi web app.
 *
 * Cookie hanya membawa token HMAC berisi `sid` (id baris `sessions`); otoritas
 * sesi ada di DB sehingga bisa dicabut. Lihat `docs/07-audit.md` §2.5.
 */

/**
 * Nama cookie sesi.
 *
 * Produksi memakai prefix `__Host-`: browser hanya menerimanya bila di-set
 * dengan `Secure`, `Path=/`, dan **tanpa** atribut `Domain` — sehingga subdomain
 * (atau host lain di belakang koma) tidak bisa menanam cookie sesi. Di dev
 * (HTTP) prefix itu ditolak browser, jadi nama polos dipakai.
 *
 * `prod` bisa diberikan eksplisit (test) tapi selalu berasal dari `isProd()` di
 * jalur nyata — nama dan atribut cookie wajib memakai flag yang sama.
 */
export function sessionCookieName(prod = isProd()): string {
  return prod ? "__Host-gattai_session" : "gattai_session";
}

/** Batas absolut sesi (7 hari) — juga dipakai sebagai `maxAge` cookie. */
export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Idle timeout: sesi tanpa aktivitas selama ini dianggap mati. */
export const SESSION_IDLE_TTL_MS = 72 * 60 * 60 * 1000;

/** Jeda minimum antar penulisan `last_seen_at` (hindari 1 write per request). */
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

/** Retensi baris sesi mati sebelum dibersihkan reaper (untuk audit sementara). */
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Atribut cookie sesi — satu sumber untuk *set* dan *hapus*.
 *
 * `secure` wajib ada di kedua jalur: browser (dan Hono) hanya menerima nama
 * berprefix `__Host-` bila cookie diserialisasi dengan `Secure` + `Path=/`.
 * Menghapus dengan `{ path: "/" }` saja membuat Hono **melempar** sehingga
 * respons menjadi 500 dan cookie justru tidak pernah terhapus.
 */
function sessionCookieOptions(prod: boolean, maxAge: number) {
  return { httpOnly: true, sameSite: "Lax" as const, secure: prod, maxAge, path: "/" };
}

/** Set cookie sesi (login). */
export function setSessionCookie(c: Context, token: string, prod = isProd()): void {
  setCookie(c, sessionCookieName(prod), token, {
    ...sessionCookieOptions(prod, Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000)),
  });
}

/** Hapus cookie sesi (logout / sesi tak sah). Idempoten. */
export function clearSessionCookie(c: Context, prod = isProd()): void {
  deleteCookie(c, sessionCookieName(prod), sessionCookieOptions(prod, 0));
}

/** Token sesi mentah dari cookie request (belum diverifikasi). */
export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, sessionCookieName());
}

export function createSessionToken(projectId: string, address: string, sid: string): string {
  return signSession({
    projectId,
    address,
    sid,
    exp: Date.now() + SESSION_ABSOLUTE_TTL_MS,
  });
}

/**
 * Verifikasi HMAC saja (tanpa cek DB/revokasi).
 *
 * Dipakai `POST /auth/logout` agar tetap idempoten dan bisa mencabut barisnya;
 * bukan untuk otorisasi.
 */
export function readSessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  return verifySession(token);
}

export interface ResolvedSession {
  sid: string;
  projectId: string;
  address: string;
}

/** Buat baris sesi + token cookie. Dipakai `/auth/verify` dan test. */
export async function createSession(
  projectId: string,
  address: string,
): Promise<{ token: string; sid: string }> {
  const sid = newId("ses");
  await db.insert(sessions).values({
    id: sid,
    projectId,
    address,
    expiresAt: new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS),
  });
  return { token: createSessionToken(projectId, address, sid), sid };
}

/**
 * Verifikasi penuh: HMAC + baris DB (`revoked_at`, batas absolut, idle timeout).
 * Mengembalikan `null` bila sesi tidak sah — pemanggil memperlakukannya sebagai
 * belum login. `last_seen_at` di-*touch* secara berkala (throttle 5 menit).
 */
export async function resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
  const payload = readSessionToken(token);
  if (!payload?.sid) return null;

  const rows = await db.select().from(sessions).where(eq(sessions.id, payload.sid)).limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return null;

  const now = Date.now();
  if (row.expiresAt.getTime() <= now) return null;
  if (now - row.lastSeenAt.getTime() > SESSION_IDLE_TTL_MS) return null;
  // Token yang menunjuk baris lain (mis. token lama untuk sesi berbeda) ditolak.
  if (row.projectId !== payload.projectId || row.address !== payload.address) return null;

  if (now - row.lastSeenAt.getTime() > TOUCH_THROTTLE_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, row.id));
  }

  return { sid: row.id, projectId: row.projectId, address: row.address };
}

/** Cabut satu sesi (logout). Idempoten. */
export async function revokeSession(sid: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sid), isNull(sessions.revokedAt)));
}

/** Cabut semua sesi project (logout-semua, atau owner wallet berubah). */
export async function revokeAllSessions(projectId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.projectId, projectId), isNull(sessions.revokedAt)));
}

/**
 * Sesi terikat pada wallet pemilik project.
 *
 * `address` di token tidak pernah "dekoratif": bila owner project berubah
 * (rotasi wallet / pemulihan akun), seluruh sesi lama dicabut dan pemilik baru
 * harus login ulang — cermin server dari rekonsiliasi wallet↔sesi di klien.
 */
export async function assertSessionOwner(
  session: { address: string },
  project: { id: string; ownerWallet: string },
): Promise<void> {
  if (session.address.toLowerCase() === project.ownerWallet.toLowerCase()) return;
  await revokeAllSessions(project.id);
  throw new ApiError(401, "UNAUTHORIZED", "Session is invalid. Sign in again.");
}

/** Hapus baris sesi mati yang lebih tua dari `olderThanMs` (housekeeping reaper). */
export async function purgeStaleSessions(olderThanMs: number): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date(Date.now() - olderThanMs)))
    .returning({ id: sessions.id });
  return deleted.length;
}
