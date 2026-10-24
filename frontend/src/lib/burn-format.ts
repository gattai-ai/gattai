import { formatUnits } from "viem";

/**
 * Format angka burn.
 *
 * Backend mengirim base-unit integer string; semua pembulatan untuk tampilan
 * terjadi di sini. `exactAmount` dipakai untuk tooltip agar angka penuh tetap
 * bisa diaudit.
 */

export function toTokenNumber(raw: string, decimals: number): number {
  try {
    const value = Number(formatUnits(BigInt(raw), decimals));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function exactAmount(raw: string, decimals: number): string {
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return "0";
  }
}

export function compactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function compactAmount(raw: string, decimals: number): string {
  return compactNumber(toTokenNumber(raw, decimals));
}

export function amount2(raw: string, decimals: number): string {
  return toTokenNumber(raw, decimals).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtPercent(value: string): string {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : "0.00%";
}
