/**
 * Eksekusi transaksi Safe generik setelah minimal threshold owner approveHash.
 *
 * Pemakaian:
 *   $env:SAFE_TX_ID="set-max-usdg"
 *   bun run --cwd contracts safe:tx:execute
 *
 * Deployer hanya mengirim execTransaction; tidak menandatangani sebagai owner.
 */
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  pad,
  parseAbi,
  parseEventLogs,
  zeroAddress,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHAIN_ID = 46630;

const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function approvedHashes(address owner, bytes32 hash) view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 txHash, uint256 payment)",
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
  if (!value) fail("DEPLOYER_PRIVATE_KEY tidak diset");
  const prefixed = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    fail("DEPLOYER_PRIVATE_KEY bukan private key 32-byte yang valid");
  }
  return prefixed as `0x${string}`;
}

interface SafeTxRecord {
  status?: string;
  chainId?: number;
  id?: string;
  description?: string;
  safeAddress?: string;
  owners?: string[];
  threshold?: number;
  nonce?: string;
  to?: string;
  value?: string;
  data?: string;
  operation?: number;
  safeTxHash?: string;
  signers?: string[];
  executionTxHash?: string;
  executionBlock?: number;
  executionGasUsed?: string;
  executedAt?: string;
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
if (record.status === "executed") {
  console.log(`Transaksi sudah dieksekusi: ${record.executionTxHash ?? "unknown"}`);
  process.exit(0);
}
if (record.status !== "prepared") {
  fail(`status transaksi ${record.status ?? "unknown"}, harus prepared`);
}
if (record.chainId !== CHAIN_ID) fail(`chain di record bukan ${CHAIN_ID}`);
if (!record.safeAddress) fail("safeAddress tidak ada di record");
if (!record.safeTxHash || !/^0x[0-9a-fA-F]{64}$/.test(record.safeTxHash)) {
  fail("safeTxHash tidak valid");
}
if (!record.to) fail("to tidak ada di record");
if (!record.data || !/^0x[0-9a-fA-F]*$/.test(record.data) || record.data.length % 2 !== 0) {
  fail("data tidak valid");
}
if (record.operation !== 0) fail("operation harus CALL (0)");
if (!record.value) fail("value tidak ada di record");

let value: bigint;
try {
  value = BigInt(record.value);
} catch {
  fail("value bukan angka bulat");
}
if (value < 0n) fail("value tidak boleh negatif");

const safeAddress = getAddress(record.safeAddress);
const to = getAddress(record.to);
const safeTxHash = record.safeTxHash as `0x${string}`;
const data = record.data as `0x${string}`;
const operation = 0;

const chainId = await publicClient.getChainId();
if (chainId !== CHAIN_ID) fail(`chain id ${chainId}, harus ${CHAIN_ID}`);

const [owners, threshold, nonce] = await Promise.all([
  publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "getOwners",
  }),
  publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "getThreshold",
  }),
  publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "nonce",
  }),
]);

if (record.nonce !== nonce.toString()) {
  fail(`nonce Safe ${nonce} != record nonce ${record.nonce}`);
}
if (record.threshold !== Number(threshold)) {
  fail(`threshold Safe ${threshold} != record threshold ${record.threshold}`);
}

const computedHash = await publicClient.readContract({
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "getTransactionHash",
  args: [
    to,
    value,
    data,
    operation,
    0n,
    0n,
    0n,
    zeroAddress,
    zeroAddress,
    nonce,
  ],
});
if (computedHash.toLowerCase() !== safeTxHash.toLowerCase()) {
  fail(`safeTxHash record ${safeTxHash} != hash onchain ${computedHash}`);
}

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
const approvedOwners = owners.filter((_, index) => approvals[index] !== 0n);
if (BigInt(approvedOwners.length) < threshold) {
  console.error(`Baru ${approvedOwners.length}/${threshold} owner approve.`);
  console.error(`Owner: ${owners.join(", ")}`);
  console.error(`Approved: ${approvedOwners.join(", ") || "none"}`);
  fail("approval belum cukup; jalankan safe:tx:approve sampai minimal threshold");
}

const sortedApproved = [...approvedOwners].sort((a, b) =>
  a.toLowerCase().localeCompare(b.toLowerCase()),
);
const signers = sortedApproved.slice(0, Number(threshold));

const signatures = concatHex(
  signers.flatMap((owner) => [
    pad(owner, { size: 32 }),
    zeroHash,
    "0x01" as const,
  ]),
);

const execArgs = [
  to,
  value,
  data,
  operation,
  0n,
  0n,
  0n,
  zeroAddress,
  zeroAddress,
  signatures,
] as const;

const executor = privateKeyToAccount(
  normalizePrivateKey(process.env.DEPLOYER_PRIVATE_KEY),
);
const walletClient = createWalletClient({
  account: executor,
  chain,
  transport: http(rpcUrl, { timeout: 30_000 }),
});

const simulation = await publicClient.simulateContract({
  account: executor.address,
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "execTransaction",
  args: execArgs,
});
if (!simulation.result) {
  fail("simulasi execTransaction mengembalikan false");
}

const calldata = encodeFunctionData({
  abi: SAFE_ABI,
  functionName: "execTransaction",
  args: execArgs,
});
const gas = await publicClient.estimateGas({
  account: executor.address,
  to: safeAddress,
  data: calldata,
});
const gasPrice = await publicClient.getGasPrice();
const balance = await publicClient.getBalance({ address: executor.address });
const estimatedCost = gas * gasPrice;
if (balance < estimatedCost) {
  fail(
    `saldo executor ${formatEther(balance)} ETH tidak cukup (estimasi ${formatEther(estimatedCost)} ETH)`,
  );
}

console.log("Mengeksekusi transaksi Safe...");
console.log(`  id:         ${id}`);
console.log(`  deskripsi:  ${record.description ?? id}`);
console.log(`  safe:       ${safeAddress}`);
console.log(`  to:         ${to}`);
console.log(`  value:      ${value}`);
console.log(`  data:       ${data}`);
console.log(`  nonce:      ${nonce}`);
console.log(`  signers:    ${signers.join(", ")}`);
console.log(`  executor:   ${executor.address}`);
console.log(`  saldo:      ${formatEther(balance)} ETH`);

const hash = await walletClient.writeContract({
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "execTransaction",
  args: execArgs,
  gas: (gas * 12n) / 10n,
});
console.log(`  tx:         ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") fail(`transaksi execTransaction gagal: ${hash}`);

const successLogs = parseEventLogs({
  abi: SAFE_ABI,
  eventName: "ExecutionSuccess",
  logs: receipt.logs,
});
const failureLogs = parseEventLogs({
  abi: SAFE_ABI,
  eventName: "ExecutionFailure",
  logs: receipt.logs,
});
if (failureLogs.length > 0) {
  fail(`Safe emit ExecutionFailure: ${hash}`);
}
if (successLogs.length !== 1) {
  fail(`event ExecutionSuccess tidak ditemukan: ${hash}`);
}
if (successLogs[0].args.txHash.toLowerCase() !== safeTxHash.toLowerCase()) {
  fail(`txHash event ${successLogs[0].args.txHash} != ${safeTxHash}`);
}

const nonceAfter = await publicClient.readContract({
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "nonce",
});
if (nonceAfter !== nonce + 1n) {
  fail(`nonce setelah eksekusi ${nonceAfter}, harus ${nonce + 1n}`);
}

const updated: SafeTxRecord = {
  ...record,
  status: "executed",
  signers,
  executionTxHash: hash,
  executionBlock: Number(receipt.blockNumber),
  executionGasUsed: receipt.gasUsed.toString(),
  executedAt: new Date().toISOString(),
};
writeFileSync(recordPath, `${JSON.stringify(updated, null, 2)}\n`);

console.log("Transaksi Safe berhasil.");
console.log(`  block:     ${receipt.blockNumber}`);
console.log(`  gasUsed:   ${receipt.gasUsed}`);
console.log(`  nonce:     ${nonceAfter}`);
console.log(`  record:    ${recordPath}`);
