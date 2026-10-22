import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/lib/http";
import { parseLimit, readCursor } from "../src/lib/pagination";

/**
 * Penjaga paginasi: limit yang ngawur tidak boleh menghasilkan query kosong
 * atau menarik seluruh tabel, dan kursor yang rusak harus 400 (bukan diam-diam
 * dianggap "tanpa kursor" sehingga halaman pertama terulang).
 */

describe("parseLimit", () => {
  test("memakai fallback untuk nilai tidak sah", () => {
    expect(parseLimit(undefined, 30, 100)).toBe(30);
    expect(parseLimit("", 30, 100)).toBe(30);
    expect(parseLimit("abc", 30, 100)).toBe(30);
    expect(parseLimit("0", 30, 100)).toBe(30);
    expect(parseLimit("-5", 30, 100)).toBe(30);
    expect(parseLimit("Infinity", 30, 100)).toBe(30);
    expect(parseLimit("NaN", 30, 100)).toBe(30);
  });

  test("membulatkan ke bawah dan mengklep ke maksimum", () => {
    expect(parseLimit("2", 30, 100)).toBe(2);
    expect(parseLimit("2.9", 30, 100)).toBe(2);
    expect(parseLimit("1", 30, 100)).toBe(1);
    expect(parseLimit("100", 30, 100)).toBe(100);
    expect(parseLimit("101", 30, 100)).toBe(100);
    expect(parseLimit("1e9", 30, 100)).toBe(100);
  });
});

describe("readCursor", () => {
  test("tanpa kursor → null", () => {
    expect(readCursor(undefined)).toBeNull();
    expect(readCursor("")).toBeNull();
  });

  test("memisahkan timestamp dan id pada `|` terakhir", () => {
    const cursor = readCursor("2026-10-18T12:00:00.000Z|conv_abc");
    expect(cursor).not.toBeNull();
    expect(cursor?.id).toBe("conv_abc");
    expect(cursor?.at.toISOString()).toBe("2026-10-18T12:00:00.000Z");
  });

  test("bentuk ngawur → 400 INVALID_CURSOR", () => {
    for (const bad of ["abc", "|conv_abc", "2026-10-18T12:00:00.000Z|", "not-a-date|conv_abc"]) {
      try {
        readCursor(bad);
        throw new Error(`cursor seharusnya ditolak: ${bad}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(400);
        expect((error as ApiError).code).toBe("INVALID_CURSOR");
      }
    }
  });
});
