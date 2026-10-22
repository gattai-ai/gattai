import { describe, expect, test } from "bun:test";
import { SEARCH_MAX, escapeLike, readSearchPattern } from "../src/lib/search";

/**
 * Pencarian daftar: wildcard `LIKE` harus diloloskan (kalau tidak, `%` user
 * mencocokkan seluruh tabel) dan query kosong tidak boleh menjadi filter.
 */

describe("escapeLike", () => {
  test("meloloskan wildcard dan backslash", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("back\\slash")).toBe("back\\\\slash");
    expect(escapeLike("%_\\")).toBe("\\%\\_\\\\");
  });

  test("teks biasa tidak diubah", () => {
    expect(escapeLike("bikin banner")).toBe("bikin banner");
  });
});

describe("readSearchPattern", () => {
  test("kosong / spasi saja → null (tanpa filter)", () => {
    expect(readSearchPattern(undefined)).toBeNull();
    expect(readSearchPattern("")).toBeNull();
    expect(readSearchPattern("   ")).toBeNull();
  });

  test("dipangkas lalu dibungkus `%`", () => {
    expect(readSearchPattern("  banner  ")).toBe("%banner%");
  });

  test("wildcard di dalam query ikut diloloskan", () => {
    expect(readSearchPattern("50%_off")).toBe("%50\\%\\_off%");
  });

  test("dipotong `SEARCH_MAX` karakter sebelum dibungkus", () => {
    const pattern = readSearchPattern("x".repeat(SEARCH_MAX + 50));
    expect(pattern).toBe(`%${"x".repeat(SEARCH_MAX)}%`);
  });
});
