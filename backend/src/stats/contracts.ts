import { MAINNET_CHAIN_ID, MAINNET_CONTRACTS, depositManagerAbi } from "@web3-starter/shared";
import { env } from "../env";
import { createRobinhoodClient } from "../onchain/client";

export interface ContractAddressInfo {
  address: string;
  explorer_url: string;
}

export interface DepositManagerInfo extends ContractAddressInfo {
  /**
   * Status paused dari onchain RPC call.
   * Nilai `null` menandakan status tidak dapat diverifikasi (RPC gagal / tidak tersedia),
   * bukan `false` (tidak menyesatkan).
   */
  paused: boolean | null;
}

export interface TokenContractInfo extends ContractAddressInfo {
  symbol: string;
  decimals: number;
}

export interface ContractsStats {
  chain_id: number;
  deposit_manager: DepositManagerInfo;
  treasury: ContractAddressInfo;
  token: TokenContractInfo;
  updated_at: string;
}

function explorerAddressUrl(address: string): string {
  return `${MAINNET_CONTRACTS.explorer}/address/${address}`;
}

/**
 * Cek apakah DepositManager dalam status paused via RPC onchain.
 * Mengembalikan `null` bila query gagal atau RPC tidak terkonfigurasi.
 */
export async function fetchDepositManagerPaused(
  contractAddress: string,
): Promise<boolean | null> {
  try {
    if (!env.robinhoodRpcUrl) return null;
    const client = createRobinhoodClient();
    const paused = await client.readContract({
      address: contractAddress as `0x${string}`,
      abi: depositManagerAbi,
      functionName: "paused",
    });
    return Boolean(paused);
  } catch {
    return null;
  }
}

/**
 * Ambil informasi kontrak onchain untuk /v1/public/stats.
 */
export async function getContractsStats(): Promise<ContractsStats> {
  const chainId = env.chainId ?? MAINNET_CHAIN_ID;
  const depositManagerAddress =
    env.depositManagerAddress ?? MAINNET_CONTRACTS.depositManager;
  const treasuryAddress = env.treasuryAddress ?? MAINNET_CONTRACTS.treasury;
  const tokenAddress = env.burnTokenAddress ?? MAINNET_CONTRACTS.token;
  const decimals = env.burnTokenDecimals ?? MAINNET_CONTRACTS.tokenDecimals;

  const paused = await fetchDepositManagerPaused(depositManagerAddress);

  return {
    chain_id: chainId,
    deposit_manager: {
      address: depositManagerAddress,
      paused,
      explorer_url: explorerAddressUrl(depositManagerAddress),
    },
    treasury: {
      address: treasuryAddress,
      explorer_url: explorerAddressUrl(treasuryAddress),
    },
    token: {
      address: tokenAddress,
      symbol: MAINNET_CONTRACTS.tokenSymbol,
      decimals,
      explorer_url: explorerAddressUrl(tokenAddress),
    },
    updated_at: new Date().toISOString(),
  };
}
