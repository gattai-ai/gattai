/**
 * Uang selalu integer micro-credits. Tidak pernah float.
 *
 *   1 credit  = harga list $0,01
 *   micro     = 1/1.000.000 credit
 *   1 credit  = 1.000.000 micro
 *
 * Konversi ke tampilan dilakukan di layer presentasi (response API).
 */

export const MICRO_PER_CREDIT = 1_000_000;
export const USD_PER_CREDIT = 0.01;

/** USD → micro-credits (dibulatkan ke integer). */
export function usdToMicro(usd: number): number {
  return Math.round(usd * 100 * MICRO_PER_CREDIT);
}

/** micro-credits → USD. */
export function microToUsd(micro: number): number {
  return micro / (100 * MICRO_PER_CREDIT);
}

/** credits → micro-credits. */
export function creditsToMicro(credits: number): number {
  return Math.round(credits * MICRO_PER_CREDIT);
}

/** micro-credits → credits. */
export function microToCredits(micro: number): number {
  return micro / MICRO_PER_CREDIT;
}

/** Format integer micro-credits menjadi string credits 6 desimal (tanpa float). */
export function microToCreditsString(micro: number | bigint): string {
  return formatMicro(micro, 6);
}

/** Format integer micro-credits menjadi string USD 8 desimal (tanpa float). */
export function microToUsdString(micro: number | bigint): string {
  return formatMicro(micro, 8);
}

/**
 * Parse string USD (maksimal 8 desimal) menjadi integer micro-USD.
 * Dipakai untuk membandingkan biaya tanpa melewati float.
 */
export function usdStringToMicroUsd(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const [wholeRaw, fractionRaw = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  const whole = BigInt(wholeRaw || "0");
  const fraction = BigInt((fractionRaw + "00000000").slice(0, 8) || "0");
  const result = whole * 100_000_000n + fraction;
  return negative ? -result : result;
}

/** Angka USD konfigurasi → integer micro-USD. */
export function usdToMicroUsd(usd: number): bigint {
  return usdStringToMicroUsd(usd.toFixed(8));
}

/**
 * Bagi integer micro dengan `10^scale` memakai aritmetika integer supaya nilai
 * uang tidak pernah melewati float saat diformat untuk API publik.
 */
function formatMicro(micro: number | bigint, scale: number): string {
  const value = typeof micro === "bigint" ? micro : BigInt(Math.trunc(micro));
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const whole = absolute / divisor;
  const fraction = String(absolute % divisor).padStart(scale, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
