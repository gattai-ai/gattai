/**
 * Konversi uang untuk perhitungan burn (integer, tanpa float).
 *
 * Skala yang dipakai konsisten dengan `onchain/credits.ts`:
 *   - `usd8`  = USD × 1e8  (sama dengan micro-credits pada harga list; 1 USD = 1e8 micro)
 *   - token GATTAI disimpan dengan 18 desimal (wei).
 */

import { USD_SCALE } from "../onchain/credits";

const PPM = 1_000_000n;
const TOKEN_SCALE = 10n ** 18n;

/**
 * Ubah string desimal (mis. nilai kolom `numeric` Postgres `"1.23456789"`)
 * menjadi USD skala-8. Toleran terhadap tanda dan jumlah desimal < 8.
 */
export function decimalToUsd8(value: string | number): bigint {
  const raw = typeof value === "number" ? value.toString() : value.trim();
  if (raw === "" || raw === "0") return 0n;

  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const [whole = "0", fraction = ""] = body.split(".");
  const wholePart = BigInt(whole === "" ? "0" : whole);
  const fracPart = BigInt((fraction + "00000000").slice(0, 8));
  const result = wholePart * USD_SCALE + fracPart;
  return negative ? -result : result;
}

/** Terapkan porsi rasio (0..1) ke nilai usd8, pembulatan ke bawah. */
export function shareUsd8(usd8: bigint, ratio: number): bigint {
  if (usd8 <= 0n || ratio <= 0) return 0n;
  if (ratio >= 1) return usd8;
  const ppm = BigInt(Math.round(ratio * 1_000_000));
  return (usd8 * ppm) / PPM;
}

/** USD skala-8 → jumlah token 18 desimal pada `price8` (USD/token, skala 8). */
export function usd8ToTokens18(usd8: bigint, price8: bigint): bigint {
  if (usd8 <= 0n || price8 <= 0n) return 0n;
  return (usd8 * TOKEN_SCALE) / price8;
}

/** Jumlah token 18 desimal → string desimal untuk kolom `numeric(38,18)`. */
export function tokens18ToDecimalString(tokens: bigint): string {
  const negative = tokens < 0n;
  const value = negative ? -tokens : tokens;
  const whole = value / TOKEN_SCALE;
  const fraction = (value % TOKEN_SCALE).toString().padStart(18, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Ubah string desimal (mis. `"12.5"`, jumlah GATTAI) menjadi jumlah 18 desimal. */
export function decimalToTokens18(value: string | number): bigint {
  const raw = typeof value === "number" ? value.toString() : value.trim();
  if (raw === "" || raw === "0") return 0n;

  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const [whole = "0", fraction = ""] = body.split(".");
  const wholePart = BigInt(whole === "" ? "0" : whole);
  const fracPart = BigInt((fraction + "0".repeat(18)).slice(0, 18));
  const result = wholePart * TOKEN_SCALE + fracPart;
  return negative ? -result : result;
}
