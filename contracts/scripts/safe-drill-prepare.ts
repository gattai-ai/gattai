/**
 * Menyiapkan drill transaksi Safe 2-of-3 tanpa mengirim transaksi.
 *
 * Hasilnya: ignition/deployments/chain-46630/safe-drill.json
 *
 * Pemakaian:
 *   bun run --cwd contracts safe:drill:prepare
 *
 * Env opsional:
 *   ROBINHOOD_RPC_URL   default https://rpc.testnet.chain.robinhood.com
 *   SAFE_DRILL_TARGET   default deployer 0x911B...
 */
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
  zeroAddress,
} from "viem";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHAIN_ID = 46630;
const DEFAULT_TARGET = "0x911Bf0fd05A53eC2d06952Ee2Fca8b17CBeA3Bad" as const;

const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(scriptDir, "..");
const deploymentDir = join(
  contractsDir,
  "ignition",
  "deployments",
  `chain-${CHAIN_ID}`,
);
const safePath = join(deploymentDir, "safe.json");
const drillPath = join(deploymentDir, "safe-drill.json");

const rpcUrl =
  process.env.ROBINHOOD_RPC_URL?.trim() ||
  "https://rpc.testnet.chain.robinhood.com";
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 30_000 }),
});

function fail(message: string): never {
  console.error(`GAGAL: ${message}`);
  process.exit(1);
}

if (!existsSync(safePath)) fail(`record Safe tidak ditemukan: ${safePath}`);
const record = JSON.parse(readFileSync(safePath, "utf8")) as {
  safeAddress?: string;
  chainId?: number;
};
if (record.chainId !== CHAIN_ID) fail(`chain di safe.json bukan ${CHAIN_ID}`);
if (!record.safeAddress) fail("safeAddress tidak ada di safe.json");
const safeAddress = getAddress(record.safeAddress);

if (existsSync(drillPath)) {
  const existing = JSON.parse(readFileSync(drillPath, "utf8")) as {
    status?: string;
    safeTxHash?: string;
  };
  if (existing.status === "executed") {
    fail(`drill sudah dieksekusi: ${existing.safeTxHash ?? "unknown"}`);
  }
}

const target = getAddress(process.env.SAFE_DRILL_TARGET ?? DEFAULT_TARGET);
const value = 0n;
const data = "0x" as const;
const operation = 0;

const [chainId, owners, threshold, nonce] = await Promise.all([
  client.getChainId(),
  client.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "getOwners",
  }),
  client.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "getThreshold",
  }),
  client.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "nonce",
  }),
]);
if (chainId !== CHAIN_ID) fail(`chain id ${chainId}, harus ${CHAIN_ID}`);
if (threshold > BigInt(owners.length)) fail("threshold lebih besar dari owner");

const safeTxHash = await client.readContract({
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "getTransactionHash",
  args: [
    target,
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

const drill = {
  schema: 1,
  status: "prepared",
  chainId: CHAIN_ID,
  safeAddress,
  owners,
  threshold: Number(threshold),
  nonce: nonce.toString(),
  target,
  value: value.toString(),
  data,
  operation,
  safeTxHash,
  createdAt: new Date().toISOString(),
};
writeFileSync(drillPath, `${JSON.stringify(drill, null, 2)}\n`);

console.log("Drill Safe disiapkan.");
console.log(`  safe:       ${safeAddress}`);
console.log(`  owners:     ${owners.join(", ")}`);
console.log(`  threshold:  ${threshold}`);
console.log(`  nonce:      ${nonce}`);
console.log(`  target:     ${target}`);
console.log(`  value:      ${value}`);
console.log(`  safeTxHash: ${safeTxHash}`);
console.log(`  record:     ${drillPath}`);
console.log("");
console.log("Langkah berikutnya: 2 owner memanggil approveHash(bytes32) di Safe.");
console.log("Gunakan owner wallet yang berbeda; jangan pakai deployer.");
