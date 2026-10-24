/**
 * Helper link explorer Robinhood Chain (Blockscout).
 *
 * Alamat explorer sebelumnya tersebar sebagai string literal; satu helper
 * mencegah link mati saat host berubah dan memudahkan pengujian.
 */

export const ROBINHOOD_EXPLORER = "https://robinhoodchain.blockscout.com";

export function explorerTxUrl(hash: string): string {
  return `${ROBINHOOD_EXPLORER}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${ROBINHOOD_EXPLORER}/address/${address}`;
}

/** `0x1234…abcd` untuk ruang sempit; alamat lengkap tetap di `title`/href. */
export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}
