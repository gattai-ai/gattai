/**
 * Konversi nilai deposit → credits (integer micro-credits).
 *
 * Skala uang (lihat docs/06-billing-and-tokenomics.md §5):
 *   1 credit = $0,01  →  $1 = 100 credits
 *   1 credit = 1.000.000 micro-credits
 *   ⇒ 1 USD = 1e8 micro-credits
 *
 * Karena itu, bila kita merepresentasikan nilai USD sebagai `usd8`
 * (USD × 1e8, bigint), maka `usd8` **sama dengan** jumlah micro-credits
 * untuk pembayaran tanpa diskon. Semua perhitungan memakai bigint → tidak
 * pernah float.
 */

/** USD (skala 8 desimal) untuk 1 unit USD penuh. */
export const USD_SCALE = 100_000_000n; // 1e8
const PPM = 1_000_000n;

/**
 * Nilai USD (skala 8 desimal) dari `amountRaw` unit terkecil token.
 * @param price8 Harga USD per 1 token penuh, skala 8 desimal.
 */
export function usdValue8(amountRaw: bigint, price8: bigint, decimals: number): bigint {
  return (amountRaw * price8) / 10n ** BigInt(decimals);
}

/**
 * Credits (micro) dari nilai USD, menerapkan diskon GATTAI.
 *
 * Diskon mengikuti contoh brief: `credits = usd / (1 − discount_ratio)`,
 * sehingga GATTAI senilai $85 → $100 credits.
 */
export function computeCreditsMicro(usd8: bigint, discountRatio = 0): bigint {
  if (discountRatio <= 0) return usd8;

  const discountPpm = BigInt(Math.round(discountRatio * 1_000_000));
  const denom = PPM - discountPpm;
  if (denom <= 0n) return usd8;

  return (usd8 * PPM) / denom;
}

/** Harga skala-8 (bigint) → number USD per unit. */
export function price8ToNumber(price8: bigint): number {
  return Number(price8) / Number(USD_SCALE);
}

/** USD skala-8 → string desimal (untuk kolom `numeric` Postgres). */
export function usd8ToDecimalString(usd8: bigint): string {
  const negative = usd8 < 0n;
  const value = negative ? -usd8 : usd8;
  const whole = value / USD_SCALE;
  const fraction = (value % USD_SCALE).toString().padStart(8, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
