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
export function microToCreditsString(micro: number): string {
  return formatMicro(micro, 6);
}

/** Format integer micro-credits menjadi string USD 8 desimal (tanpa float). */
export function microToUsdString(micro: number): string {
  return formatMicro(micro, 8);
}

/**
 * Bagi integer micro dengan `10^scale` memakai aritmetika integer supaya nilai
 * uang tidak pernah melewati float saat diformat untuk API publik.
 */
function formatMicro(micro: number, scale: number): string {
  const negative = micro < 0;
  const absolute = Math.abs(Math.trunc(micro));
  const divisor = 10 ** scale;
  const whole = Math.floor(absolute / divisor);
  const fraction = String(absolute % divisor).padStart(scale, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
