import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import app from "../src/app";
import {
  clearSessionCookie,
  sessionCookieName,
  setSessionCookie,
} from "../src/auth/session";

/**
 * Regresi produksi: cookie `__Host-` HANYA sah bila diserialisasi dengan
 * `Secure` + `Path=/` (tanpa `Domain`). Hono **melempar** bila tidak.
 *
 * Sebelumnya `POST /auth/logout` dan pembersihan cookie di `GET /auth/me`
 * memakai `deleteCookie(c, nama, { path: "/" })` tanpa `secure`, sehingga di
 * produksi keduanya membalas 500 — bukan 200/401. Bug itu tidak terlihat di
 * suite biasa karena semuanya berjalan dengan `NODE_ENV=test`, yang memakai
 * nama tanpa prefix.
 *
 * Di sini jalur produksi diuji apa adanya lewat parameter `prod` (tanpa
 * mengubah `process.env`), plus dua test rute nyata yang sengaja menjalankan
 * proses dalam mode produksi singkat.
 */

/** Aplikasi kecil untuk menguji helper cookie tanpa menyentuh DB. */
function cookieApp() {
  const mini = new Hono();
  mini.onError((error, c) => c.json({ error: error.message }, 500));
  mini.post("/set-prod", (c) => {
    setSessionCookie(c, "token.abc", true);
    return c.json({ ok: true });
  });
  mini.post("/clear-prod", (c) => {
    clearSessionCookie(c, true);
    return c.json({ ok: true });
  });
  mini.post("/clear-dev", (c) => {
    clearSessionCookie(c, false);
    return c.json({ ok: true });
  });
  return mini;
}

describe("nama cookie sesi", () => {
  test("produksi memakai prefix __Host-, dev memakai nama polos", () => {
    expect(sessionCookieName(true)).toBe("__Host-gattai_session");
    expect(sessionCookieName(false)).toBe("gattai_session");
  });
});

describe("serialisasi cookie sesi produksi", () => {
  test("set memuat Secure, Path=/ , HttpOnly, SameSite, dan Max-Age", async () => {
    const res = await cookieApp().request("/set-prod", { method: "POST" });
    expect(res.status).toBe(200);

    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain("__Host-gattai_session=token.abc");
    expect(header).toContain("Secure");
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Max-Age=604800");
  });

  test("clear tidak melempar dan mengirim Max-Age=0 + Secure", async () => {
    const res = await cookieApp().request("/clear-prod", { method: "POST" });
    expect(res.status).toBe(200);

    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain("__Host-gattai_session=;");
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Secure");
    expect(header).toContain("Path=/");
  });

  test("dev tidak memakai prefix maupun Secure (HTTP lokal)", async () => {
    const res = await cookieApp().request("/clear-dev", { method: "POST" });
    expect(res.status).toBe(200);

    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain("gattai_session=;");
    expect(header).toContain("Max-Age=0");
    expect(header).not.toContain("Secure");
  });
});

/**
 * Jalur rute nyata dalam mode produksi.
 *
 * `bun test` menjalankan berkas test berurutan dalam satu proses (kecuali
 * `--parallel`), jadi `process.env` yang diubah sementara di sini aman — sama
 * seperti pola di `env.test.ts`. Nilainya selalu dipulihkan di `finally`.
 */
describe("rute auth pada mode produksi", () => {
  async function inProd(run: () => Promise<void>): Promise<void> {
    const savedNodeEnv = process.env.NODE_ENV;
    const savedSecret = process.env.SESSION_SECRET;
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "a".repeat(32);
    try {
      await run();
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
      if (savedSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = savedSecret;
    }
  }

  test("POST /auth/logout → 200 (dulu 500) + cookie __Host- dibersihkan", async () => {
    await inProd(async () => {
      const res = await app.request("/auth/logout", { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const header = res.headers.get("set-cookie") ?? "";
      expect(header).toContain("__Host-gattai_session=;");
      expect(header).toContain("Max-Age=0");
    });
  });

  test("GET /auth/me tanpa sesi → 401 (dulu 500) + cookie dibersihkan", async () => {
    await inProd(async () => {
      const res = await app.request("/auth/me");
      expect(res.status).toBe(401);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "UNAUTHORIZED" },
      });

      const header = res.headers.get("set-cookie") ?? "";
      expect(header).toContain("__Host-gattai_session=;");
      expect(header).toContain("Max-Age=0");
    });
  });
});
