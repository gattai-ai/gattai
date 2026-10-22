import { describe, expect, test } from "bun:test";
import {
  allowedOrigins,
  isAllowedOrigin,
  originAllowed,
  parseAllowedOrigins,
} from "../src/lib/origins";

/**
 * `FRONTEND_URL` menentukan CORS **dan** penjaga CSRF; wildcard di produksi
 * membuat keduanya tidak berarti. Karena itu salah-konfigurasi harus gagal keras.
 */

describe("parseAllowedOrigins", () => {
  test("produksi + kosong → gagal", () => {
    expect(() => parseAllowedOrigins(undefined, true)).toThrow();
    expect(() => parseAllowedOrigins("", true)).toThrow();
  });

  test('produksi + wildcard → gagal (termasuk wildcard campuran)', () => {
    expect(() => parseAllowedOrigins("*", true)).toThrow();
    expect(() => parseAllowedOrigins("https://app.example,*", true)).toThrow();
  });

  test("produksi + origin nyata → ok, dipisah koma & di-trim", () => {
    expect(parseAllowedOrigins(" https://app.example , https://www.app.example ", true)).toEqual([
      "https://app.example",
      "https://www.app.example",
    ]);
  });

  test("non-produksi + kosong → wildcard (dev tetap jalan)", () => {
    expect(parseAllowedOrigins(undefined, false)).toEqual(["*"]);
  });
});

describe("originAllowed", () => {
  test("origin kosong selalu lolos (curl/SDK tanpa Origin)", () => {
    expect(originAllowed(undefined, ["https://app.example"])).toBe(true);
    expect(originAllowed("", ["https://app.example"])).toBe(true);
  });

  test("daftar wildcard meloloskan apa pun", () => {
    expect(originAllowed("https://evil.example", ["*"])).toBe(true);
  });

  test("cocok persis saja; origin lain ditolak", () => {
    const origins = ["https://app.example", "https://www.app.example"];
    expect(originAllowed("https://app.example", origins)).toBe(true);
    expect(originAllowed("https://www.app.example", origins)).toBe(true);
    // Prefix/subdomain palsu tidak lolos.
    expect(originAllowed("https://evil.example", origins)).toBe(false);
    expect(originAllowed("https://app.example.evil.example", origins)).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  test("memakai daftar dari FRONTEND_URL", () => {
    expect(allowedOrigins.length).toBeGreaterThan(0);
    expect(isAllowedOrigin(allowedOrigins[0])).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
    // Wildcard (hanya mungkin di non-produksi) berarti meloloskan apa pun.
    expect(isAllowedOrigin("https://evil.example")).toBe(allowedOrigins.includes("*"));
  });
});
