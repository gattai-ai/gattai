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
