import { robinhood, robinhoodTestnet } from "viem/chains";

export { robinhood, robinhoodTestnet };

/**
 * Daftar chain yang didukung aplikasi.
 * Menambah chain = menambah satu entri di sini. Tidak ada perubahan lain
 * di komponen React maupun di lib/wagmi.ts.
 */
export const supportedChains = [robinhoodTestnet, robinhood] as const;

/** Chain default untuk development. */
export const defaultChain = robinhoodTestnet;

export type SupportedChain = (typeof supportedChains)[number];
export type SupportedChainId = SupportedChain["id"];
