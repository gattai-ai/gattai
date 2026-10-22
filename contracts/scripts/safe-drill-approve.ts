/**
 * Owner menyetujui hash drill Safe dengan approveHash(bytes32).
 *
 * Pemakaian (satu kali per owner, di shell terpisah):
 *   $env:OWNER_PRIVATE_KEY="0x..."; bun run --cwd contracts safe:drill:approve
 *
 * Jangan simpan OWNER_PRIVATE_KEY di contracts/.env atau file yang di-commit.
 * Script ini hanya memakai key owner untuk menandatangani approveHash.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHAIN_ID = 46630;

const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function approvedHashes(address owner, bytes32 hash) view returns (uint256)",
  "function approveHash(bytes32 hash)",
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(scriptDir, "..");
const drillPath = join(
  contractsDir,
  "ignition",
  "deployments",
  `chain-${CHAIN_ID}`,
  "safe-drill.json",
);

const rpcUrl =
  process.env.ROBINHOOD_RPC_URL?.trim() ||
  "https://rpc.testnet.chain.robinhood.com";
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 30_000 }),
});

function fail(message: string): never {
  console.error(`GAGAL: ${message}`);
  process.exit(1);
}

function normalizePrivateKey(raw: string | undefined): `0x${string}` {
  const value = raw?.trim();
  if (!value) fail("OWNER_PRIVATE_KEY tidak diset");
  const prefixed = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    fail("OWNER_PRIVATE_KEY bukan private key 32-byte yang valid");
  }
  return prefixed as `0x${string}`;
}

const ownerAccount = privateKeyToAccount(
  normalizePrivateKey(process.env.OWNER_PRIVATE_KEY),
);
const walletClient = createWalletClient({
  account: ownerAccount,
  chain,
  transport: http(rpcUrl, { timeout: 30_000 }),
});

let drill: {
  status?: string;
  safeAddress?: string;
  safeTxHash?: string;
  nonce?: string;
};
try {
  drill = JSON.parse(readFileSync(drillPath, "utf8"));
} catch {
  fail(`record drill tidak bisa dibaca: ${drillPath}`);
}
if (drill.status !== "prepared") {
  fail(`status drill ${drill.status ?? "unknown"}, harus prepared`);
}
if (!drill.safeAddress) fail("safeAddress tidak ada di safe-drill.json");
if (!drill.safeTxHash || !/^0x[0-9a-fA-F]{64}$/.test(drill.safeTxHash)) {
  fail("safeTxHash tidak valid");
}
const safeAddress = getAddress(drill.safeAddress);
const safeTxHash = drill.safeTxHash as `0x${string}`;

const chainId = await publicClient.getChainId();
if (chainId !== CHAIN_ID) fail(`chain id ${chainId}, harus ${CHAIN_ID}`);

const owners = await publicClient.readContract({
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "getOwners",
});
if (!owners.some((owner) => owner.toLowerCase() === ownerAccount.address.toLowerCase())) {
  fail(`${ownerAccount.address} bukan owner Safe`);
}

const alreadyApproved = await publicClient.readContract({
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "approvedHashes",
  args: [ownerAccount.address, safeTxHash],
});
if (alreadyApproved !== 0n) {
  console.log(`Owner ${ownerAccount.address} sudah approve hash ini.`);
  process.exit(0);
}

const approveData = encodeFunctionData({
  abi: SAFE_ABI,
  functionName: "approveHash",
  args: [safeTxHash],
});
const balance = await publicClient.getBalance({ address: ownerAccount.address });
const gas = await publicClient.estimateGas({
  account: ownerAccount.address,
  to: safeAddress,
  data: approveData,
});
const gasPrice = await publicClient.getGasPrice();
const estimatedCost = gas * gasPrice;
if (balance < estimatedCost) {
  fail(
    `saldo owner ${formatEther(balance)} ETH tidak cukup (estimasi ${formatEther(estimatedCost)} ETH)`,
  );
}

await publicClient.simulateContract({
  account: ownerAccount.address,
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "approveHash",
  args: [safeTxHash],
});

console.log("Mengirim approveHash...");
console.log(`  safe:   ${safeAddress}`);
console.log(`  owner:  ${ownerAccount.address}`);
console.log(`  hash:   ${safeTxHash}`);
console.log(`  nonce:  ${drill.nonce ?? "unknown"}`);
console.log(`  saldo:  ${formatEther(balance)} ETH`);

const hash = await walletClient.writeContract({
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "approveHash",
  args: [safeTxHash],
  gas: (gas * 12n) / 10n,
});
console.log(`  tx:     ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") fail(`transaksi approveHash gagal: ${hash}`);

const approved = await publicClient.readContract({
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "approvedHashes",
  args: [ownerAccount.address, safeTxHash],
});
if (approved === 0n) fail("approveHash tidak tercatat onchain");

const threshold = await publicClient.readContract({
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "getThreshold",
});
const approvals = await Promise.all(
  owners.map((owner) =>
    publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "approvedHashes",
      args: [owner, safeTxHash],
    }),
  ),
);
const approvedCount = approvals.filter((value) => value !== 0n).length;

console.log("approveHash berhasil.");
console.log(`  block:    ${receipt.blockNumber}`);
console.log(`  approved: ${approvedCount}/${threshold}`);
if (approvedCount < Number(threshold)) {
  console.log("Langkah berikutnya: owner kedua menjalankan approveHash untuk hash yang sama.");
} else {
  console.log("Langkah berikutnya: jalankan safe:drill:execute dari deployer.");
}
