/**
 * Registry resmi Robinhood Chain mainnet (Chain ID 4663).
 *
 * Sumber kebenaran alamat produksi untuk stats, indexer, dan explorer.
 */

export const MAINNET_CHAIN_ID = 4663;

export const MAINNET_CONTRACTS = {
  chainId: MAINNET_CHAIN_ID,
  depositManager: "0xbf1F9ea84820B619EdC58eD15304Eb22547fBC07",
  treasury: "0x5a777DAB051a2D05638b851330E7360C9333B905",
  token: "0x863019e2e676164fcfaab6e14dcd6568eb6deb1f",
  tokenSymbol: "GATTAI",
  tokenDecimals: 18,
  usdgToken: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  usdgDecimals: 6,
  explorer: "https://robinhoodchain.blockscout.com",
} as const;
