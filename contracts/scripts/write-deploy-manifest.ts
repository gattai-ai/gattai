/**
 * Menulis manifest deploy dari hasil Ignition. Jalankan setelah deploy:
 *
 *   bun run --cwd contracts manifest:mainnet
 *   bun run --cwd contracts manifest:testnet
 *
 * Output: ignition/deployments/chain-<id>/deploy-manifest.json
 *
 * Manifest ini adalah sumber `INDEXER_FROM_BLOCK`; `scripts/sync-contracts.mjs`
 * hanya menyalin alamat/ABI dan tidak menyimpan block deployment.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type DeployedAddresses = Record<string, string>;
type JournalEntry = {
  type?: string;
  futureId?: string;
  hash?: string;
  transaction?: { hash?: string };
  receipt?: { blockNumber?: number; status?: string };
};
type BuildInfo = {
  solcLongVersion?: string;
  input?: {
    settings?: {
      evmVersion?: string;
      optimizer?: { enabled?: boolean; runs?: number };
    };
    sources?: Record<string, unknown>;
  };
};
type MainnetParams = {
  DepositManagerModule?: Record<string, unknown>;
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(scriptDir, "..");
const repoRoot = join(contractsDir, "..");
const chainId = process.argv[2] ?? "4663";
const deploymentDir = join(
  contractsDir,
  "ignition",
  "deployments",
  `chain-${chainId}`,
);
const addressesPath = join(deploymentDir, "deployed_addresses.json");
const journalPath = join(deploymentDir, "journal.jsonl");
const paramsFile =
  chainId === "4663"
    ? "mainnet.json"
    : chainId === "46630"
      ? "testnet.json"
      : null;
const paramsPath = paramsFile
  ? join(contractsDir, "ignition", "parameters", paramsFile)
  : null;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function buildInfoSummary(info: BuildInfo): {
  compiler: string | null;
  evmVersion: string | null;
  optimizer: { enabled: boolean | null; runs: number | null };
} {
  return {
    compiler: info.solcLongVersion ?? null,
    evmVersion: info.input?.settings?.evmVersion ?? null,
    optimizer: {
      enabled: info.input?.settings?.optimizer?.enabled ?? null,
      runs: info.input?.settings?.optimizer?.runs ?? null,
    },
  };
}

function findBuildInfo(contractName: string): {
  compiler: string | null;
  evmVersion: string | null;
  optimizer: { enabled: boolean | null; runs: number | null };
} {
  // Sumber utama: build-info yang benar-benar direferensikan artifact terbaru.
  // Jangan memilih build-info pertama yang cocok berdasarkan nama source:
  // deployment lama bisa menyisakan build-info dengan evmVersion berbeda
  // (mis. osaka) sehingga manifest tidak sesuai bytecode yang di-deploy.
  const artifactPath = join(
    contractsDir,
    "artifacts",
    "contracts",
    `${contractName}.sol`,
    `${contractName}.json`,
  );
  if (existsSync(artifactPath)) {
    const artifact = readJson<{ buildInfoId?: string }>(artifactPath);
    if (artifact.buildInfoId) {
      const artifactBuildInfoPath = join(
        contractsDir,
        "artifacts",
        "build-info",
        `${artifact.buildInfoId}.json`,
      );
      if (existsSync(artifactBuildInfoPath)) {
        return buildInfoSummary(readJson<BuildInfo>(artifactBuildInfoPath));
      }
    }
  }

  // Fallback untuk deployment lama tanpa artifact lokal.
  const buildInfoDir = join(deploymentDir, "build-info");
  if (!existsSync(buildInfoDir)) {
    return {
      compiler: null,
      evmVersion: null,
      optimizer: { enabled: null, runs: null },
    };
  }

  const files = readdirSync(buildInfoDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  for (const file of files) {
    const info = readJson<BuildInfo>(join(buildInfoDir, file));
    const sources = Object.keys(info.input?.sources ?? {});
    if (!sources.some((source) => source.endsWith(`${contractName}.sol`))) {
      continue;
    }
    return buildInfoSummary(info);
  }

  return {
    compiler: null,
    evmVersion: null,
    optimizer: { enabled: null, runs: null },
  };
}

function main(): void {
  if (!existsSync(addressesPath)) {
    throw new Error(`deployed_addresses.json tidak ditemukan: ${addressesPath}`);
  }
  if (!existsSync(journalPath)) {
    throw new Error(`journal.jsonl tidak ditemukan: ${journalPath}`);
  }

  const addresses = readJson<DeployedAddresses>(addressesPath);
  const address = addresses["DepositManagerModule#DepositManager"];
  if (!address) {
    throw new Error(
      "DepositManagerModule#DepositManager tidak ada di deployed_addresses.json; deploy Fase 1 (DepositManagerModule) dulu",
    );
  }

  const entries = readFileSync(journalPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as JournalEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is JournalEntry => entry !== null);

  // `findLast` penting: journal bersifat append-only dan bisa berisi deployment
  // lama (mis. percobaan yang di-wipe lalu diulang). Manifest harus memakai
  // transaksi konfirmasi terakhir yang sesuai dengan alamat aktif.
  const deployment = entries.findLast(
    (entry) =>
      entry.type === "TRANSACTION_CONFIRM" &&
      entry.futureId === "DepositManagerModule#DepositManager" &&
      typeof entry.receipt?.blockNumber === "number",
  );
  if (!deployment) {
    throw new Error(
      "transaksi deployment DepositManager tidak ditemukan di journal.jsonl",
    );
  }

  const txHash = deployment.hash ?? deployment.transaction?.hash ?? null;
  if (!txHash) {
    throw new Error("tx hash deployment tidak ditemukan di journal.jsonl");
  }

  const params =
    paramsPath && existsSync(paramsPath)
      ? readJson<MainnetParams>(paramsPath).DepositManagerModule ?? {}
      : {};
  const build = findBuildInfo("DepositManager");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

  const manifest = {
    schema: 1,
    chainId: Number(chainId),
    contract: "DepositManager",
    address,
    transactionHash: txHash,
    blockNumber: deployment.receipt?.blockNumber ?? null,
    receiptStatus: deployment.receipt?.status ?? null,
    commit,
    branch,
    parameters: params,
    compiler: build.compiler,
    evmVersion: build.evmVersion,
    optimizer: build.optimizer,
    generatedAt: new Date().toISOString(),
  };

  const outPath = join(deploymentDir, "deploy-manifest.json");
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Manifest ditulis: ${outPath}`);
  console.log(
    `INDEXER_FROM_BLOCK=${manifest.blockNumber} (chain ${manifest.chainId})`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    "Gagal menulis manifest:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
}
