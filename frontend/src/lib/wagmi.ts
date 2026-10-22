import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
// Tipe Chain dan Transport berasal dari viem, bukan dari wagmi.
import type { Chain, Transport } from "viem";
import {
  defaultChain as sharedDefaultChain,
  supportedChains,
  type SupportedChainId,
} from "@shared/chains";

/**
 * Override RPC per chain lewat env `VITE_RPC_URLS`.
 *
 * Format: `"<chainId>=<url>,<chainId>=<url>"`, contoh:
 *   VITE_RPC_URLS=46630=https://robinhood-sepolia-rpc.publicnode.com
 *
 * Needed karena `rpcUrls.default` bawaan viem bisa tidak terjangkau dari
 * jaringan lokal (DNS diblokir ISP/pemerintah). Tanpa ini, wallet gagal
 * membaca chain dan top-up tidak bisa dikirim despite backend sehat.
 */
function rpcOverrides(): Partial<Record<SupportedChainId, string>> {
  const raw = import.meta.env.VITE_RPC_URLS as string | undefined;
  const map: Partial<Record<SupportedChainId, string>> = {};
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const [id, url] = pair.split("=").map((part) => part?.trim());
    if (!id || !url) continue;
    map[Number(id) as SupportedChainId] = url;
  }
  return map;
}

const overrides = rpcOverrides();

/**
 * Chain default untuk build ini.
 *
 * Dev/testnet tidak mengisi apa pun (default testnet). Build mainnet WAJIB
 * mengisi `VITE_DEFAULT_CHAIN_ID=4663`, supaya wallet tidak diminta pindah ke
 * testnet dan top-up tidak dikirim ke chain yang salah.
 */
const configuredDefaultId = Number(import.meta.env.VITE_DEFAULT_CHAIN_ID ?? "");
const configuredDefault = supportedChains.find(
  (chain) => chain.id === configuredDefaultId,
);
const orderedChains = configuredDefault
  ? ([configuredDefault, ...supportedChains.filter((chain) => chain.id !== configuredDefault.id)] as const)
  : supportedChains;

/**
 * Satu transport HTTP per chain, dibuat otomatis dari daftar chain di
 * shared/chains, dengan override RPC opsional dari env.
 */
const transports = Object.fromEntries(
  orderedChains.map((chain: Chain) => [
    chain.id,
    http(overrides[chain.id as SupportedChainId]),
  ]),
) as Record<SupportedChainId, Transport>;

export const wagmiConfig = createConfig({
  chains: orderedChains,
  connectors: [injected()],
  transports,
  ssr: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export const defaultChain = orderedChains[0] ?? sharedDefaultChain;
export { supportedChains };
