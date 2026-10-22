/**
 * Impor dan verifikasi Safe mainnet (chain 4663) yang dibuat lewat Safe web app.
 *
 * Pemakaian:
 *   $env:SAFE_ADDRESS="0x..."
 *   bun run --cwd contracts import:safe:mainnet
 *
 * Opsional:
 *   SAFE_IMPORT_DRY_RUN=1       verifikasi tanpa menulis record
 *   ROBINHOOD_MAINNET_RPC_URL=...
 *
 * Script ini TIDAK membuat Safe dan TIDAK mengirim transaksi. Ia hanya:
 * 1. Memeriksa chain, bytecode, singleton, owner, threshold, version, dan nonce.
 * 2. Menulis record ke ignition/deployments/chain-4663/safe.json.
 *
 * Owner dan threshold dipatok ke kebijakan treasury Fase 1. Jika Safe di web
 * app berbeda, script gagal.
 */
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHAIN_ID = 4663;
const EXPECTED_THRESHOLD = 2n;
const DEPLOYER = "0x911Bf0fd05A53eC2d06952Ee2Fca8b17CBeA3Bad" as const;
const EXPECTED_OWNERS = [
  "0x21956BF41857869aed193b899678b8b4AC24e485",
  "0xB1Ce61a8851Db965034D48Ee39b9d80429d21834",
  "0x1a6Dd8dB12F6BD6FDC610a9e3727E198ED27Cc71",
] as const;

const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(scriptDir, "..");
const deploymentDir = join(
  contractsDir,
  "ignition",
  "deployments",
  `chain-${CHAIN_ID}`,
);
const recordPath = join(deploymentDir, "safe.json");

const rpcUrl =
  process.env.ROBINHOOD_MAINNET_RPC_URL?.trim() ||
  "https://rpc.mainnet.chain.robinhood.com";
const dryRun = process.env.SAFE_IMPORT_DRY_RUN === "1";

const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const client = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 }),
});

interface SafeRecord {
  schema?: number;
  chainId?: number;
  safeAddress?: string;
  owners?: string[];
  threshold?: number;
  singleton?: string;
  version?: string | null;
  nonce?: string;
}

function fail(message: string): never {
  console.error(`GAGAL: ${message}`);
  process.exit(1);
}

function parseSafeAddress(): Address {
  const raw = process.env.SAFE_ADDRESS?.trim() || process.argv[2]?.trim();
  if (!raw) {
    fail("SAFE_ADDRESS tidak diset (atau kirim alamat sebagai argumen pertama)");
  }
  try {
    return getAddress(raw);
  } catch {
    fail(`SAFE_ADDRESS bukan alamat yang valid: ${raw}`);
  }
}

async function main(): Promise<void> {
  const safeAddress = parseSafeAddress();

  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) {
    fail(`chain id ${chainId}, harus ${CHAIN_ID}`);
  }

  const blockNumber = await client.getBlockNumber();
  const code = await client.getCode({ address: safeAddress });
  if (!code || code === "0x") {
    fail(`alamat ${safeAddress} tidak punya bytecode di chain ${CHAIN_ID}`);
  }

  // Safe proxy menyimpan alamat singleton di storage slot 0.
  const storage0 = await client.getStorageAt({
    address: safeAddress,
    slot: "0x0",
  });
  if (!storage0 || /^0x0+$/.test(storage0)) {
    fail("storage slot 0 kosong; bukan Safe proxy yang valid");
  }
  const singleton = getAddress(`0x${storage0.slice(-40)}`);
  const singletonCode = await client.getCode({ address: singleton });
  if (!singletonCode || singletonCode === "0x") {
    fail(`singleton ${singleton} tidak punya bytecode`);
  }

  const [rawOwners, threshold, version, nonce] = await Promise.all([
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
    client
      .readContract({
        address: safeAddress,
        abi: SAFE_ABI,
        functionName: "VERSION",
      })
      .catch(() => null),
    client.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "nonce",
    }),
  ]);

  if (!version) {
    fail("VERSION() tidak bisa dibaca dari Safe");
  }

  const owners = rawOwners.map((owner) => getAddress(owner));
  if (owners.length !== EXPECTED_OWNERS.length) {
    fail(
      `jumlah owner ${owners.length}, harus ${EXPECTED_OWNERS.length}`,
    );
  }

  const actualOwnerSet = new Set(
    owners.map((owner) => owner.toLowerCase()),
  );
  for (const expectedOwner of EXPECTED_OWNERS) {
    if (!actualOwnerSet.has(expectedOwner.toLowerCase())) {
      fail(`owner ${expectedOwner} tidak ada di Safe`);
    }
  }

  if (threshold !== EXPECTED_THRESHOLD) {
    fail(`threshold ${threshold}, harus ${EXPECTED_THRESHOLD}`);
  }

  if (owners.some((owner) => owner.toLowerCase() === DEPLOYER.toLowerCase())) {
    fail("deployer tidak boleh menjadi salah satu owner Safe");
  }

  console.log("Safe mainnet terverifikasi.");
  console.log(`  chain:       ${chainId}`);
  console.log(`  safe:        ${safeAddress}`);
  console.log(`  version:     ${version}`);
  console.log(`  singleton:   ${singleton}`);
  console.log(`  owners:      ${owners.join(", ")}`);
  console.log(`  threshold:   ${threshold}`);
  console.log(`  nonce:       ${nonce}`);
  console.log(`  block:       ${blockNumber}`);

  if (existsSync(recordPath)) {
    let existing: SafeRecord;
    try {
      existing = JSON.parse(readFileSync(recordPath, "utf8")) as SafeRecord;
    } catch {
      fail(`record yang sudah ada tidak bisa dibaca: ${recordPath}`);
    }

    const sameAddress =
      existing.safeAddress?.toLowerCase() === safeAddress.toLowerCase();
    const sameThreshold = existing.threshold === Number(threshold);
    const existingOwners = (existing.owners ?? [])
      .map((owner) => owner.toLowerCase())
      .sort();
    const currentOwners = owners
      .map((owner) => owner.toLowerCase())
      .sort();
    const sameOwners =
      JSON.stringify(existingOwners) === JSON.stringify(currentOwners);

    if (
      existing.chainId !== CHAIN_ID ||
      !sameAddress ||
      !sameThreshold ||
      !sameOwners
    ) {
      fail(
        `record sudah ada tetapi berbeda: ${recordPath}; arsipkan manual jika ingin mengganti`,
      );
    }

    console.log("Record Safe sudah ada dan cocok; tidak ditimpa.");
    console.log(`  record: ${recordPath}`);
    return;
  }

  const record = {
    schema: 1,
    chainId: CHAIN_ID,
    source: "safe-web",
    safeAddress,
    owners,
    threshold: Number(threshold),
    singleton,
    version,
    nonce: nonce.toString(),
    importedAtBlock: Number(blockNumber),
    importedAt: new Date().toISOString(),
  };

  if (dryRun) {
    console.log("SAFE_IMPORT_DRY_RUN=1: record tidak ditulis.");
    return;
  }

  mkdirSync(deploymentDir, { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  console.log("Record Safe berhasil ditulis.");
  console.log(`  record: ${recordPath}`);
  console.log(
    "Langkah berikutnya: isi DepositManagerModule.treasury di ignition/parameters/mainnet.json.",
  );
}

main().catch((error) => {
  console.error(
    "Import Safe gagal:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
