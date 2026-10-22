/**
 * Owner menyetujui safeTxHash transaksi Safe generik dengan approveHash(bytes32).
 *
 * Pemakaian (satu kali per owner, di shell terpisah):
 *   $env:SAFE_TX_ID="set-max-usdg"
 *   $env:OWNER_PRIVATE_KEY="0x..."
 *   bun run --cwd contracts safe:tx:approve
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
import { readFileSync, writeFileSync } from "node:fs";
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
const deploymentDir = join(
  contractsDir,
  "ignition",
  "deployments",
  `chain-${CHAIN_ID}`,
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

interface SafeTxRecord {
  status?: string;
  chainId?: number;
  id?: string;
  safeAddress?: string;
  nonce?: string;
  safeTxHash?: string;
  approvals?: Array<{
    owner: string;
    txHash: string;
    block: number;
    approvedAt: string;
  }>;
}

const id = process.env.SAFE_TX_ID?.trim();
if (!id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
  fail("SAFE_TX_ID wajib berupa slug huruf kecil/angka/tanda hubung");
}
const recordPath = join(deploymentDir, `safe-tx-${id}.json`);

let record: SafeTxRecord;
try {
  record = JSON.parse(readFileSync(recordPath, "utf8")) as SafeTxRecord;
} catch {
  fail(`record transaksi tidak bisa dibaca: ${recordPath}`);
}
if (record.status !== "prepared") {
  fail(`status transaksi ${record.status ?? "unknown"}, harus prepared`);
}
if (record.chainId !== CHAIN_ID) fail(`chain di record bukan ${CHAIN_ID}`);
if (!record.safeAddress) fail("safeAddress tidak ada di record");
if (!record.safeTxHash || !/^0x[0-9a-fA-F]{64}$/.test(record.safeTxHash)) {
  fail("safeTxHash tidak valid");
}

const safeAddress = getAddress(record.safeAddress);
const safeTxHash = record.safeTxHash as `0x${string}`;

const ownerAccount = privateKeyToAccount(
  normalizePrivateKey(process.env.OWNER_PRIVATE_KEY),
);
const walletClient = createWalletClient({
  account: ownerAccount,
  chain,
  transport: http(rpcUrl, { timeout: 30_000 }),
});

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
console.log(`  id:     ${id}`);
console.log(`  safe:   ${safeAddress}`);
console.log(`  owner:  ${ownerAccount.address}`);
console.log(`  hash:   ${safeTxHash}`);
console.log(`  nonce:  ${record.nonce ?? "unknown"}`);
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

const approvals = record.approvals ?? [];
if (!approvals.some((entry) => entry.owner.toLowerCase() === ownerAccount.address.toLowerCase())) {
  approvals.push({
    owner: ownerAccount.address,
    txHash: hash,
    block: Number(receipt.blockNumber),
    approvedAt: new Date().toISOString(),
  });
}
const updated: SafeTxRecord = {
  ...record,
  approvals,
};
writeFileSync(recordPath, `${JSON.stringify(updated, null, 2)}\n`);

const threshold = await publicClient.readContract({
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "getThreshold",
});
const approvedHashes = await Promise.all(
  owners.map((owner) =>
    publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "approvedHashes",
      args: [owner, safeTxHash],
    }),
  ),
);
const approvedCount = approvedHashes.filter((value) => value !== 0n).length;

console.log("approveHash berhasil.");
console.log(`  block:    ${receipt.blockNumber}`);
console.log(`  approved: ${approvedCount}/${threshold}`);
if (approvedCount < Number(threshold)) {
  console.log("Langkah berikutnya: owner kedua menjalankan approveHash untuk hash yang sama.");
} else {
  console.log("Langkah berikutnya: jalankan safe:tx:execute dari deployer.");
}
