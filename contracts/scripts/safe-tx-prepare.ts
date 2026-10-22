/**
 * Menyiapkan transaksi Safe generik (bukan hanya drill no-op).
 *
 * Pemakaian:
 *   $env:SAFE_TX_ID="set-max-usdg"
 *   $env:SAFE_TX_TO="0x..."
 *   $env:SAFE_TX_DATA="0x..."
 *   bun run --cwd contracts safe:tx:prepare
 *
 * Env:
 *   SAFE_TX_ID           wajib; slug unik, mis. `set-max-usdg`
 *   SAFE_TX_TO           wajib; alamat target
 *   SAFE_TX_DATA         wajib; calldata (0x...)
 *   SAFE_TX_VALUE        opsional; default 0
 *   SAFE_TX_OPERATION    opsional; default 0 (CALL)
 *   SAFE_TX_DESCRIPTION  opsional
 *
 * Record: ignition/deployments/chain-46630/safe-tx-<id>.json
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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} tidak diset`);
  return value;
}

function parseAddress(name: string): `0x${string}` {
  try {
    return getAddress(requiredEnv(name));
  } catch {
    fail(`${name} bukan alamat yang valid`);
  }
}

const id = requiredEnv("SAFE_TX_ID");
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
  fail("SAFE_TX_ID harus slug huruf kecil/angka/tanda hubung, maksimal 64 karakter");
}

const to = parseAddress("SAFE_TX_TO");
const data = requiredEnv("SAFE_TX_DATA");
if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length % 2 !== 0) {
  fail("SAFE_TX_DATA harus hex 0x... dengan jumlah digit genap");
}
const valueRaw = process.env.SAFE_TX_VALUE?.trim() || "0";
let value: bigint;
try {
  value = BigInt(valueRaw);
} catch {
  fail("SAFE_TX_VALUE bukan angka bulat");
}
if (value < 0n) fail("SAFE_TX_VALUE tidak boleh negatif");

const operation = Number(process.env.SAFE_TX_OPERATION?.trim() || "0");
if (operation !== 0) {
  fail("SAFE_TX_OPERATION hanya mendukung 0 (CALL) untuk tool ini");
}

const description = process.env.SAFE_TX_DESCRIPTION?.trim() || id;
const recordPath = join(deploymentDir, `safe-tx-${id}.json`);
if (existsSync(recordPath)) {
  fail(`record sudah ada: ${recordPath}; pakai SAFE_TX_ID lain`);
}

if (!existsSync(safePath)) fail(`record Safe tidak ditemukan: ${safePath}`);
const safeRecord = JSON.parse(readFileSync(safePath, "utf8")) as {
  safeAddress?: string;
  chainId?: number;
};
if (safeRecord.chainId !== CHAIN_ID) fail(`chain di safe.json bukan ${CHAIN_ID}`);
if (!safeRecord.safeAddress) fail("safeAddress tidak ada di safe.json");
const safeAddress = getAddress(safeRecord.safeAddress);

const chainId = await client.getChainId();
if (chainId !== CHAIN_ID) fail(`chain id ${chainId}, harus ${CHAIN_ID}`);

const [owners, threshold, nonce] = await Promise.all([
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

const safeTxHash = await client.readContract({
  address: safeAddress,
  abi: SAFE_ABI,
  functionName: "getTransactionHash",
  args: [
    to,
    value,
    data as `0x${string}`,
    operation,
    0n,
    0n,
    0n,
    zeroAddress,
    zeroAddress,
    nonce,
  ],
});

const record = {
  schema: 1,
  status: "prepared",
  chainId: CHAIN_ID,
  id,
  description,
  safeAddress,
  owners,
  threshold: Number(threshold),
  nonce: nonce.toString(),
  to,
  value: value.toString(),
  data,
  operation,
  safeTxHash,
  createdAt: new Date().toISOString(),
};
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

console.log("Transaksi Safe disiapkan.");
console.log(`  id:          ${id}`);
console.log(`  deskripsi:   ${description}`);
console.log(`  safe:        ${safeAddress}`);
console.log(`  nonce:       ${nonce}`);
console.log(`  to:          ${to}`);
console.log(`  value:       ${value}`);
console.log(`  data:        ${data}`);
console.log(`  safeTxHash:  ${safeTxHash}`);
console.log(`  record:      ${recordPath}`);
console.log("");
console.log("Langkah berikutnya: 2 owner memanggil approveHash untuk hash ini.");
