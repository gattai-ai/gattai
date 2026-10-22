import { describe, expect, test } from "bun:test";
import { formatRelativeTime, formatShortDateTime } from "../src/lib/format";

/** Pemformat tanggal yang tampil di daftar (History, Usage, API keys). */

describe("formatShortDateTime", () => {
  test("kosong / null → tanda hubung", () => {
    expect(formatShortDateTime(null)).toBe("-");
    expect(formatShortDateTime(undefined)).toBe("-");
    expect(formatShortDateTime("")).toBe("-");
  });

  test("tanggal tidak valid → tanda hubung", () => {
    expect(formatShortDateTime("bukan-tanggal")).toBe("-");
    expect(formatShortDateTime(new Date("bukan-tanggal"))).toBe("-");
  });

  test("string ISO dan instance Date memberi hasil sama", () => {
    const iso = "2026-10-18T12:00:00.000Z";
    expect(formatShortDateTime(iso)).toBe(formatShortDateTime(new Date(iso)));
  });

  test("berbahasa Inggris (bukan locale Indonesia)", () => {
    const out = formatShortDateTime("2026-10-18T12:00:00.000Z");

    expect(out).toMatch(/^Oct \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
    expect(out).not.toMatch(/Okt|Des|Agu|Mei/);
  });
});

describe("formatRelativeTime", () => {
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  test("baru saja → `just now`", () => {
    expect(formatRelativeTime(ago(5))).toBe("just now");
    expect(formatRelativeTime(ago(59))).toBe("just now");
  });

  test("menit dan jam memakai satuan pendek", () => {
    expect(formatRelativeTime(ago(5 * 60))).toBe("5m ago");
    expect(formatRelativeTime(ago(59 * 60))).toBe("59m ago");
    expect(formatRelativeTime(ago(3 * 3600))).toBe("3h ago");
    expect(formatRelativeTime(ago(23 * 3600))).toBe("23h ago");
  });

  test("lebih dari sehari jatuh ke tanggal ringkas yang juga berbahasa Inggris", () => {
    expect(formatRelativeTime(ago(2 * 86_400))).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
  });

  test("waktu di masa depan tidak pernah jadi `-Nm ago`", () => {
    expect(formatRelativeTime(new Date(Date.now() + 60_000).toISOString())).toBe("just now");
  });

  test("tanggal tidak valid → tanda hubung", () => {
    expect(formatRelativeTime("bukan-tanggal")).toBe("-");
  });
});
