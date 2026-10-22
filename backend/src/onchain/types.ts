/** Tipe bersama modul onchain (deposit). */

export type Hex = `0x${string}`;

/** Alamat sentinel untuk ETH native (sesuai `DepositManager.NATIVE`). */
export const NATIVE_TOKEN: Hex = "0x0000000000000000000000000000000000000000";

/** Sumber lot yang dibentuk dari deposit (menentukan jalur burn). */
export type LotSource = "ETH" | "USDG" | "GATTAI";

/** Deskripsi token yang bisa di-deposit. */
export interface TokenSpec {
  symbol: LotSource;
  address: Hex;
  decimals: number;
}

/** Pemetaan alamat token → spesifikasi token. */
export interface TokenRegistry {
  byAddress(address: string): TokenSpec | undefined;
  all(): TokenSpec[];
}
