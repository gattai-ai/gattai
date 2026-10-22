/**
 * Menambahkan token ERC-20 ke allowlist DepositManager.
 *
 * PENTING:
 * - Pemanggil harus OWNER DepositManager. Di mainnet owner adalah Safe, jadi
 *   transaksi harus dibuat lewat Safe UI — skrip EOA ini akan revert bila
 *   dijalankan dengan key yang bukan owner.
 * - Untuk mainnet, isi `DEPOSIT_MANAGER_ADDRESS`, `GATTAI_TOKEN_ADDRESS`, dan
 *   `CHAIN_ID=4663`, lalu jalankan dengan `CONFIRM_MAINNET=yes`.
 *
 * Pemakaian testnet:
 *   CHAIN_ID=46630 bun scripts/allowlist-token.ts
 */

import dotenv from "dotenv";
import { resolve } from "path";
dotenv.config({ path: resolve("backend/.env") });

import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood, robinhoodTestnet } from "viem/chains";
import { depositManagerAbi } from "../../shared/contracts/abis/DepositManager";
import { addresses } from "../../shared/contracts/addresses";

const chainId = process.env.CHAIN_ID?.trim() || "46630";
const isMainnet = chainId === "4663";
const chain = isMainnet ? robinhood : robinhoodTestnet;

const rpcUrl = isMainnet
  ? process.env.ROBINHOOD_MAINNET_RPC_URL || process.env.ROBINHOOD_RPC_URL
  : process.env.ROBINHOOD_RPC_URL || "https://robinhood-sepolia-rpc.publicnode.com";

const privateKey = isMainnet
  ? process.env.MAINNET_DEPLOYER_PRIVATE_KEY
  : process.env.TREASURY_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;

const manifest = (addresses as Record<string, Record<string, string> | undefined>)[chainId];

const depositManager = (process.env.DEPOSIT_MANAGER_ADDRESS ||
  manifest?.DepositManager) as `0x${string}` | undefined;
const gattaiToken = (process.env.GATTAI_TOKEN_ADDRESS ||
  manifest?.GattaiToken) as `0x${string}` | undefined;

if (isMainnet && process.env.CONFIRM_MAINNET !== "yes") {
  console.error("Mainnet diblokir. Set CONFIRM_MAINNET=yes setelah memverifikasi alamat.");
  process.exit(1);
}
if (!rpcUrl) {
  console.error("RPC URL belum diset (ROBINHOOD_MAINNET_RPC_URL / ROBINHOOD_RPC_URL).");
  process.exit(1);
}
if (!privateKey) {
  console.error(
    isMainnet
      ? "MAINNET_DEPLOYER_PRIVATE_KEY belum diset."
      : "TREASURY_PRIVATE_KEY atau DEPLOYER_PRIVATE_KEY belum diset.",
  );
  process.exit(1);
}
if (!depositManager || !gattaiToken) {
  console.error(
    `Alamat DepositManager/GattaiToken tidak ditemukan untuk chain ${chainId}. ` +
      "Isi env DEPOSIT_MANAGER_ADDRESS dan GATTAI_TOKEN_ADDRESS.",
  );
  process.exit(1);
}

const account = privateKeyToAccount(
  (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`,
);

const client = createWalletClient({
  account,
  chain,
  transport: http(rpcUrl),
});

const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl),
});

async function main() {
  const owner = (await publicClient.readContract({
    address: depositManager,
    abi: depositManagerAbi,
    functionName: "owner",
  })) as string;

  console.log(`Chain: ${chain.name} (${chain.id})`);
  console.log(`DepositManager: ${depositManager}`);
  console.log(`Owner: ${owner}`);
  console.log(`Pemanggil: ${account.address}`);

  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    console.error(
      "Pemanggil bukan owner. Di mainnet, buat transaksi setTokenAccepted lewat Safe.",
    );
    process.exit(1);
  }

  console.log(`Menjalankan setTokenAccepted untuk ${gattaiToken}...`);
  const txHash = await client.writeContract({
    address: depositManager,
    abi: depositManagerAbi,
    functionName: "setTokenAccepted",
    args: [gattaiToken, true],
  });

  console.log(`Tx broadcasted: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Status: ${receipt.status}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
