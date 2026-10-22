import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createRateLimiter } from "../src/middleware/rate-limit";

function testApp(max: number, windowMs = 60_000) {
  const app = new Hono();
  app.use(
    "*",
    createRateLimiter({
      windowMs,
      max,
      key: (c) => c.req.header("x-test-key") ?? "shared",
    }),
  );
  app.get("/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("rate limiter", () => {
  test("melewatkan dalam batas, menolak selebihnya dengan 429 + Retry-After", async () => {
    const app = testApp(2);
    expect((await app.request("/ping")).status).toBe(200);
    expect((await app.request("/ping")).status).toBe(200);

    const limited = await app.request("/ping");
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: { code: string; retry_after_ms: number } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retry_after_ms).toBeGreaterThan(0);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  test("kunci berbeda punya bucket sendiri", async () => {
    const app = testApp(1);
    expect((await app.request("/ping", { headers: { "x-test-key": "a" } })).status).toBe(200);
    expect((await app.request("/ping", { headers: { "x-test-key": "b" } })).status).toBe(200);
    expect((await app.request("/ping", { headers: { "x-test-key": "a" } })).status).toBe(429);
  });

  test("OPTIONS tidak dihitung", async () => {
    const app = testApp(1);
    await app.request("/ping", { method: "OPTIONS" });
    await app.request("/ping", { method: "OPTIONS" });
    expect((await app.request("/ping")).status).toBe(200);
  });

  test("jendela baru mengatur ulang hitungan", async () => {
    const app = testApp(1, 30);
    expect((await app.request("/ping")).status).toBe(200);
    expect((await app.request("/ping")).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await app.request("/ping")).status).toBe(200);
  });
});
