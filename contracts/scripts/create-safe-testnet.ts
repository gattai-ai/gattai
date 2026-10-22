/**
 * Membuat Safe 2-of-3 di Robinhood Chain testnet (chain 46630).
 *
 * Pemakaian:
 *   bun run --cwd contracts create:safe:testnet
 *   SAFE_DRY_RUN=1 bun run --cwd contracts create:safe:testnet
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY   wajib; key deployer testnet (0x opsional)
 *   ROBINHOOD_RPC_URL      default https://rpc.testnet.chain.robinhood.com
 *   SAFE_SALT_NONCE        opsional; default timestamp
 *   SAFE_DRY_RUN=1         hanya simulasi, tidak mengirim transaksi
 *
 * Script ini:
 * 1. Memvalidasi chain, owner, factory, singleton, dan saldo deployer.
 * 2. Simulasi createProxyWithNonce sebelum mengirim.
 * 3. Membuat Safe, memverifikasi owner/threshold/nonce/version.
 * 4. Menulis record ke ignition/deployments/chain-46630/safe.json.
 *
 * Jangan pernah mencetak private key.
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
  parseEventLogs,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHAIN_ID = 46630;
const SAFE_FACTORY = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2" as const;
const SAFE_SINGLETON = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552" as const;
const SAFE_THRESHOLD = 2n;
const OWNERS = [
  "0x21956BF41857869aed193b899678b8b4AC24e485",
  "0xB1Ce61a8851Db965034D48Ee39b9d80429d21834",
  "0x1a6Dd8dB12F6BD6FDC610a9e3727E198ED27Cc71",
] as const;

const SAFE_ABI = parseAbi([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function VERSION() view returns (string)",
]);
const SAFE_FACTORY_ABI = parseAbi([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address proxy, address singleton)",
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(scriptDir, "..");
const recordPath = join(
  contractsDir,
  "ignition",
  "deployments",
  `chain-${CHAIN_ID}`,
  "safe.json",
);

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

function validateOwners(owners: readonly string[]): `0x${string}`[] {
  if (owners.length !== 3) fail("jumlah owner harus 3");
  const normalized = owners.map((owner) => {
    try {
      return getAddress(owner);
    } catch {
      fail(`alamat owner tidak valid: ${owner}`);
    }
  });
  const unique = new Set(normalized.map((owner) => owner.toLowerCase()));
  if (unique.size !== normalized.length) fail("alamat owner duplikat");
  return normalized;
}

const rpcUrl =
  process.env.ROBINHOOD_RPC_URL?.trim() ||
  "https://rpc.testnet.chain.robinhood.com";
const dryRun = process.env.SAFE_DRY_RUN === "1";

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

const account = privateKeyToAccount(normalizePrivateKey(process.env.DEPLOYER_PRIVATE_KEY));
const walletClient = createWalletClient({
  account,
  chain,
  transport: http(rpcUrl, { timeout: 30_000 }),
});

const owners = validateOwners(OWNERS);
if (owners.some((owner) => owner.toLowerCase() === account.address.toLowerCase())) {
  fail("deployer tidak boleh menjadi salah satu owner Safe");
}

const chainId = await publicClient.getChainId();
if (chainId !== CHAIN_ID) fail(`chain id ${chainId}, harus ${CHAIN_ID}`);

for (const [label, address] of [
  ["Safe factory", SAFE_FACTORY],
  ["Safe singleton", SAFE_SINGLETON],
] as const) {
  const code = await publicClient.getCode({ address });
  if (code === undefined || code === "0x") fail(`${label} tidak punya code`);
}

for (const owner of owners) {
  const code = await publicClient.getCode({ address: owner });
  if (code !== undefined && code !== "0x") fail(`owner ${owner} adalah kontrak, bukan EOA`);
}

const balance = await publicClient.getBalance({ address: account.address });
const initializer = encodeFunctionData({
  abi: SAFE_ABI,
  functionName: "setup",
  args: [
    owners,
    SAFE_THRESHOLD,
    zeroAddress,
    "0x",
    zeroAddress,
    zeroAddress,
    0n,
    zeroAddress,
  ],
});

const baseSalt = process.env.SAFE_SALT_NONCE
  ? BigInt(process.env.SAFE_SALT_NONCE)
  : BigInt(Date.now());

let salt = baseSalt;
let predictedSafe: `0x${string}` | undefined;

for (let attempt = 0; attempt < 5; attempt++) {
  salt = baseSalt + BigInt(attempt);
  try {
    const candidate = await publicClient.simulateContract({
      account: account.address,
      address: SAFE_FACTORY,
      abi: SAFE_FACTORY_ABI,
      functionName: "createProxyWithNonce",
      args: [SAFE_SINGLETON, initializer, salt],
    });
    const code = await publicClient.getCode({ address: candidate.result });
    if (code === undefined || code === "0x") {
      predictedSafe = candidate.result;
      break;
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    fail(`simulasi createProxyWithNonce gagal: ${message}`);
  }
}
if (predictedSafe === undefined) {
  fail("tidak menemukan salt yang menghasilkan alamat Safe kosong");
}

const data = encodeFunctionData({
  abi: SAFE_FACTORY_ABI,
  functionName: "createProxyWithNonce",
  args: [SAFE_SINGLETON, initializer, salt],
});
const gas = await publicClient.estimateGas({
  account: account.address,
  to: SAFE_FACTORY,
  data,
});
const gasPrice = await publicClient.getGasPrice();
const estimatedCost = gas * gasPrice;

console.log("Safe testnet 2-of-3");
console.log(`  chain:        ${chainId}`);
console.log(`  rpc:          ${rpcUrl}`);
console.log(`  deployer:     ${account.address}`);
console.log(`  balance:      ${formatEther(balance)} ETH`);
console.log(`  owners:       ${owners.join(", ")}`);
console.log(`  threshold:    ${SAFE_THRESHOLD}`);
console.log(`  factory:      ${SAFE_FACTORY}`);
console.log(`  singleton:    ${SAFE_SINGLETON}`);
console.log(`  saltNonce:    ${salt}`);
console.log(`  predicted:    ${predictedSafe}`);
console.log(`  gas estimate: ${gas} (${formatEther(estimatedCost)} ETH)`);

if (balance < estimatedCost) {
  fail("saldo deployer tidak cukup untuk estimasi gas");
}

if (dryRun) {
  console.log("SAFE_DRY_RUN=1: simulasi berhasil, transaksi tidak dikirim.");
  process.exit(0);
}

if (existsSync(recordPath)) {
  fail(`record sudah ada: ${recordPath}; hapus/arsipkan manual jika ingin membuat Safe baru`);
}

console.log("Mengirim transaksi createProxyWithNonce...");
const hash = await walletClient.writeContract({
  address: SAFE_FACTORY,
  abi: SAFE_FACTORY_ABI,
  functionName: "createProxyWithNonce",
  args: [SAFE_SINGLETON, initializer, salt],
  gas: (gas * 12n) / 10n,
});
console.log(`  tx: ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") fail(`transaksi gagal: ${hash}`);

const [proxyCreated] = parseEventLogs({
  abi: SAFE_FACTORY_ABI,
  eventName: "ProxyCreation",
  logs: receipt.logs,
});
if (!proxyCreated) fail("event ProxyCreation tidak ditemukan");
const safeAddress = proxyCreated.args.proxy;
if (safeAddress.toLowerCase() !== predictedSafe.toLowerCase()) {
  fail(`alamat Safe ${safeAddress} != prediksi ${predictedSafe}`);
}

const safeCode = await publicClient.getCode({ address: safeAddress });
if (safeCode === undefined || safeCode === "0x") fail("Safe tidak punya code");

const [safeOwners, threshold, nonce] = await Promise.all([
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

const version = await publicClient
  .readContract({ address: safeAddress, abi: SAFE_ABI, functionName: "VERSION" })
  .catch(() => null);

if (safeOwners.length !== owners.length) fail("jumlah owner onchain tidak sesuai");
if (
  safeOwners.some(
    (owner, index) => owner.toLowerCase() !== owners[index].toLowerCase(),
  )
) {
  fail(`owner onchain tidak sesuai: ${safeOwners.join(", ")}`);
}
if (threshold !== SAFE_THRESHOLD) fail(`threshold onchain ${threshold}`);
if (nonce !== 0n) fail(`nonce awal Safe ${nonce}, harus 0`);

const record = {
  schema: 1,
  chainId: CHAIN_ID,
  safeAddress,
  owners,
  threshold: Number(threshold),
  factory: SAFE_FACTORY,
  singleton: SAFE_SINGLETON,
  fallbackHandler: zeroAddress,
  saltNonce: salt.toString(),
  transactionHash: hash,
  blockNumber: Number(receipt.blockNumber),
  gasUsed: receipt.gasUsed.toString(),
  deployer: account.address,
  version,
  createdAt: new Date().toISOString(),
};

mkdirSync(dirname(recordPath), { recursive: true });
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

console.log("Safe berhasil dibuat dan diverifikasi.");
console.log(`  safe:    ${safeAddress}`);
console.log(`  version: ${version ?? "unknown"}`);
console.log(`  nonce:   ${nonce}`);
console.log(`  record:  ${recordPath}`);
