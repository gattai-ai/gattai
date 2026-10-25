import { describe, expect, test } from "bun:test";
import { apiUrl, resolveApiBase } from "../src/lib/api";

/**
 * Regresi produksi: build lama mengisi `VITE_API_URL=""`. Empty string bukan
 * nullish, jadi base URL tidak boleh ikut kosong. Semua request harus tetap
 * same-origin ke `/api` supaya Caddy mem-proxy ke backend, bukan fallback SPA.
 */
describe("resolveApiBase", () => {
  test("nilai kosong/undefined/whitespace memakai /api", () => {
    expect(resolveApiBase(undefined)).toBe("/api");
    expect(resolveApiBase("")).toBe("/api");
    expect(resolveApiBase("   ")).toBe("/api");
    expect(resolveApiBase("/")).toBe("/api");
  });

  test("trailing slash dinormalisasi", () => {
    expect(resolveApiBase("/api/")).toBe("/api");
    expect(resolveApiBase("https://api.example.com/")).toBe("https://api.example.com");
  });

  test("apiUrl memakai prefix same-origin", () => {
    expect(apiUrl("/v1/public/stats")).toBe("/api/v1/public/stats");
  });
});
