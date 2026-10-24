import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import app from "../src/app";
import { createRateLimiter, ipKey } from "../src/middleware/rate-limit";

/**
 * P2 — pertahanan berlapis: penjaga CSRF (Origin/Sec-Fetch-Site), larangan
 * cache respons terautentikasi, header dasar, dan penafsiran X-Forwarded-For
 * yang tidak bisa dipalsukan klien.
 */

const ALLOWED_ORIGIN = "http://localhost:5173";

describe("penjaga CSRF (Origin / Sec-Fetch-Site)", () => {
  test("Origin diizinkan → lolos", async () => {
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(200);
  });

  test("Origin asing → 403 CSRF_BLOCKED", async () => {
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CSRF_BLOCKED");
  });

  test("Sec-Fetch-Site: cross-site → 403", async () => {
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  test("tanpa Origin (curl/SDK) → lolos", async () => {
    const res = await app.request("/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("metode aman (GET) tidak diblokir walau Origin asing", async () => {
    const res = await app.request("/auth/me", { headers: { origin: "https://evil.example" } });
    expect(res.status).not.toBe(403);
  });
});

describe("header keamanan & cache", () => {
  test("respons terautentikasi → no-store + nosniff", async () => {
    const res = await app.request("/auth/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("endpoint publik memakai cache singkat, bukan no-store", async () => {
    const res = await app.request("/v1/public/burns");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=30");
  });
});

describe("kolektor laporan CSP", () => {
  test("laporan valid → 204 (dan tidak diblokir penjaga Origin)", async () => {
    const res = await app.request("/v1/public/csp-report", {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, "content-type": "application/csp-report" },
      body: JSON.stringify({
        "csp-report": {
          "effective-directive": "script-src",
          "blocked-uri": "https://cdn.example/app.js",
          "document-uri": "http://localhost:5173/app",
        },
      }),
    });
    expect(res.status).toBe(204);
  });

  test("body kosong / bukan JSON → tetap 204 (tidak pernah mengejutkan user)", async () => {
    const empty = await app.request("/v1/public/csp-report", { method: "POST" });
    expect(empty.status).toBe(204);

    const garbage = await app.request("/v1/public/csp-report", {
      method: "POST",
      body: "not json at all",
    });
    expect(garbage.status).toBe(204);
  });
});

describe("rate limit per IP (anti-spoof XFF)", () => {
  function ipApp(max = 1) {
    const test = new Hono();
    test.use("*", createRateLimiter({ windowMs: 60_000, max, key: ipKey }));
    test.get("/ping", (c) => c.json({ ok: true }));
    return test;
  }

  test("memakai hop terkanan, bukan paling kiri", async () => {
    const test = ipApp(1);
    expect(
      (await test.request("/ping", { headers: { "x-forwarded-for": "9.9.9.9" } })).status,
    ).toBe(200);

    // Klien memalsukan entri kiri; IP nyata (terkanan) sama → bucket sama → 429.
    const spoofed = await test.request("/ping", {
      headers: { "x-forwarded-for": "1.1.1.1, 9.9.9.9" },
    });
    expect(spoofed.status).toBe(429);
  });

  test("IP nyata berbeda → bucket berbeda", async () => {
    const test = ipApp(1);
    await test.request("/ping", { headers: { "x-forwarded-for": "9.9.9.9" } });
    const other = await test.request("/ping", { headers: { "x-forwarded-for": "8.8.8.8" } });
    expect(other.status).toBe(200);
  });

  test("X-Real-IP dipakai bila XFF tidak ada", async () => {
    const test = ipApp(1);
    await test.request("/ping", { headers: { "x-real-ip": "7.7.7.7" } });
    const same = await test.request("/ping", { headers: { "x-real-ip": "7.7.7.7" } });
    expect(same.status).toBe(429);
  });
});
