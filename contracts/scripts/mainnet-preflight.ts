/**
 * Preflight read-only untuk deploy `DepositManager` Fase 1 ke Robinhood Chain
 * mainnet. Script ini tidak mengirim transaksi. Ia hanya boleh keluar dengan
 * kode 0 jika semua pengecekan wajib lulus.
 *
 * Pemakaian:
 *   MAINNET_DEPLOYER_PRIVATE_KEY=0x... bun run --cwd contracts preflight:mainnet
 *
 * Untuk pengecekan read-only tanpa private key, boleh memakai:
 *   PREFLIGHT_DEPLOYER_ADDRESS=0x... bun run --cwd contracts preflight:mainnet
 *
 * Env opsional:
 *   ROBINHOOD_MAINNET_RPC_URL   default https://rpc.mainnet.chain.robinhood.com
 *   PREFLIGHT_MIN_BALANCE_ETH   default 0.001 (gas Robinhood Chain sangat murah;
 *                               naikkan bila harga gas sedang tinggi)
 *   PREFLIGHT_ALLOW_DIRTY=1     hanya untuk lokal; jangan dipakai saat deploy
 *   PREFLIGHT_MIN_SAFE_OWNERS   default 3
 *   PREFLIGHT_MIN_SAFE_THRESHOLD default 2
 *   USDG_DECIMALS               kalau diisi, harus sama dengan onchain
 *   PREFLIGHT_MAX_DEPOSIT_USDG  batas atas cap per deposit (dalam USDG)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ZERO = "0x0000000000000000000000000000000000000000";
const EXPECTED_CHAIN_ID = 4663;
const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(scriptDir, "..");
const repoRoot = join(contractsDir, "..");
const paramsPath = join(contractsDir, "ignition", "parameters", "mainnet.json");
const hardhatConfigPath = join(contractsDir, "hardhat.config.ts");

type Address = `0x${string}`;
type MainnetParams = {
  DepositManagerModule?: {
    treasury?: string;
    nativeAccepted?: boolean;
    usdgToken?: string;
    gattaiToken?: string;
    usdgMaxAmount?: string;
    gattaiMaxAmount?: string;
    nativeMaxAmount?: string;
  };
};

let failed = false;

function ok(label: string, detail?: string): void {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function warn(label: string, detail: string): void {
  console.warn(`! ${label} — ${detail}`);
}

function fail(label: string, detail: string): void {
  failed = true;
  console.error(`✗ ${label} — ${detail}`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function asAddress(value: string | undefined): Address | null {
  if (!value || !isAddress(value) || value.toLowerCase() === ZERO) return null;
  return getAddress(value);
}

async function main(): Promise<void> {
  console.log("GATTAI — mainnet preflight (Fase 1 USDG-only)");
  console.log("");

  if (!existsSync(paramsPath)) {
    fail("parameter mainnet", `file tidak ditemukan: ${paramsPath}`);
    return;
  }
  if (!existsSync(hardhatConfigPath)) {
    fail("hardhat config", `file tidak ditemukan: ${hardhatConfigPath}`);
    return;
  }

  const params = readJson<MainnetParams>(paramsPath);
  const dm = params.DepositManagerModule;
  if (!dm) {
    fail("parameter mainnet", "`DepositManagerModule` tidak ada di mainnet.json");
    return;
  }

  // EVM target harus dipatok, bukan mengikuti default compiler/Hardhat.
  const configText = readFileSync(hardhatConfigPath, "utf8");
  const evmMatch = configText.match(/evmVersion\s*:\s*["']([^"']+)["']/);
  if (!evmMatch) {
    fail("EVM target", "`evmVersion` belum dipatok di hardhat.config.ts");
  } else if (evmMatch[1] !== "cancun") {
    warn(
      "EVM target",
      `dipatok ke ${evmMatch[1]}, bukan cancun; pastikan Robinhood Chain mendukungnya`,
    );
  } else {
    ok("EVM target", "cancun");
  }

  // Pastikan deploy dari commit yang bersih. Ini bisa di-bypass hanya untuk
  // menjalankan preflight di lokal sebelum commit.
  try {
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    if (dirty && process.env.PREFLIGHT_ALLOW_DIRTY !== "1") {
      fail(
        "working tree",
        "masih ada perubahan/untracked file; commit dulu atau set PREFLIGHT_ALLOW_DIRTY=1 hanya untuk lokal",
      );
    } else {
      ok(
        "working tree",
        dirty ? "dirty (diizinkan via PREFLIGHT_ALLOW_DIRTY=1)" : "bersih",
      );
    }
    ok("commit", commit.slice(0, 12));
  } catch {
    warn("git", "tidak bisa membaca status/commit repository");
  }

  const rpcUrl =
    process.env.ROBINHOOD_MAINNET_RPC_URL ??
    "https://rpc.mainnet.chain.robinhood.com";
  ok("RPC", rpcUrl);

  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 1 }),
  });

  try {
    const chainId = await client.getChainId();
    if (chainId !== EXPECTED_CHAIN_ID) {
      fail("chain ID", `dapat ${chainId}, harus ${EXPECTED_CHAIN_ID}`);
    } else {
      ok("chain ID", String(chainId));
    }
  } catch (error) {
    fail("RPC", error instanceof Error ? error.message : String(error));
    return;
  }

  // Deployer: private key dipakai untuk deploy, alamat saja cukup untuk
  // pengecekan read-only.
  let deployer: Address | null = null;
  const privateKey = process.env.MAINNET_DEPLOYER_PRIVATE_KEY?.trim();
  if (privateKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      fail("deployer", "MAINNET_DEPLOYER_PRIVATE_KEY bukan private key 32 byte");
    } else {
      deployer = privateKeyToAccount(privateKey as Address).address;
    }
  } else {
    deployer = asAddress(process.env.PREFLIGHT_DEPLOYER_ADDRESS);
    if (!deployer) {
      fail(
        "deployer",
        "set MAINNET_DEPLOYER_PRIVATE_KEY atau PREFLIGHT_DEPLOYER_ADDRESS",
      );
    }
  }

  // 0.001 ETH sudah sekitar 50 juta gas pada 0.02 gwei. Deploy Fase 1 hanya
  // membutuhkan sekitar 2 juta gas, jadi default lama 0.01 ETH terlalu besar
  // untuk Robinhood Chain. Naikkan lewat env bila harga gas sedang tinggi.
  const minBalance = parseEther(process.env.PREFLIGHT_MIN_BALANCE_ETH ?? "0.001");
  if (deployer) {
    ok("deployer", deployer);
    try {
      const balance = await client.getBalance({ address: deployer });
      if (balance < minBalance) {
        fail(
          "saldo deployer",
          `${formatEther(balance)} ETH; minimal ${formatEther(minBalance)} ETH`,
        );
      } else {
        ok("saldo deployer", `${formatEther(balance)} ETH`);
      }
    } catch (error) {
      fail("saldo deployer", error instanceof Error ? error.message : String(error));
    }
  }

  // Treasury harus kontrak Safe yang sudah ter-deploy.
  const treasury = asAddress(dm.treasury);
  if (!treasury) {
    fail("treasury", "harus alamat non-zero yang valid di mainnet.json");
  } else {
    ok("treasury", treasury);
    try {
      const code = await client.getCode({ address: treasury });
      if (!code || code === "0x") {
        fail("treasury", "alamat tidak punya bytecode (bukan Safe ter-deploy)");
      } else {
        const [owners, threshold] = await Promise.all([
          client.readContract({
            address: treasury,
            abi: SAFE_ABI,
            functionName: "getOwners",
          }),
          client.readContract({
            address: treasury,
            abi: SAFE_ABI,
            functionName: "getThreshold",
          }),
        ]);
        const minOwners = Number(process.env.PREFLIGHT_MIN_SAFE_OWNERS ?? "3");
        const minThreshold = BigInt(
          process.env.PREFLIGHT_MIN_SAFE_THRESHOLD ?? "2",
        );
        ok(
          "Safe treasury",
          `${owners.length} owner, threshold ${threshold.toString()}`,
        );
        if (owners.length < minOwners) {
          fail(
            "Safe owners",
            `${owners.length}; minimal ${minOwners} sesuai kebijakan`,
          );
        }
        if (threshold < minThreshold) {
          fail(
            "Safe threshold",
            `${threshold.toString()}; minimal ${minThreshold.toString()}`,
          );
        }
      }
    } catch (error) {
      fail(
        "Safe treasury",
        `tidak bisa membaca getOwners/getThreshold: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (dm.nativeAccepted !== false) {
    fail("nativeAccepted", "harus `false` untuk Fase 1 USDG-only");
  } else {
    ok("nativeAccepted", "false");
  }

  if (dm.gattaiToken) {
    fail("gattaiToken", "harus kosong untuk Fase 1");
  } else {
    ok("gattaiToken", "kosong");
  }

  const usdg = asAddress(dm.usdgToken);
  let usdgDecimals: number | null = null;
  if (!usdg) {
    fail("USDG", "`usdgToken` harus alamat non-zero yang valid");
  } else {
    ok("USDG", usdg);
    try {
      const code = await client.getCode({ address: usdg });
      if (!code || code === "0x") {
        fail("USDG", "alamat tidak punya bytecode");
      } else {
        usdgDecimals = Number(
          await client.readContract({
            address: usdg,
            abi: ERC20_ABI,
            functionName: "decimals",
          }),
        );
        let symbol = "USDG";
        try {
          symbol = await client.readContract({
            address: usdg,
            abi: ERC20_ABI,
            functionName: "symbol",
          });
        } catch {
          warn("USDG symbol", "tidak bisa dibaca; lanjut dengan decimals");
        }
        ok("USDG decimals", `${usdgDecimals} (${symbol})`);

        const expectedDecimals = process.env.USDG_DECIMALS?.trim();
        if (
          expectedDecimals &&
          Number(expectedDecimals) !== usdgDecimals
        ) {
          fail(
            "USDG_DECIMALS",
            `env ${expectedDecimals} != onchain ${usdgDecimals}`,
          );
        }
      }
    } catch (error) {
      fail("USDG decimals", error instanceof Error ? error.message : String(error));
    }
  }

  const capRaw = dm.usdgMaxAmount ? BigInt(dm.usdgMaxAmount) : 0n;
  if (capRaw <= 0n) {
    fail("usdgMaxAmount", "harus > 0; `0` berarti tanpa batas");
  } else if (usdgDecimals !== null) {
    const capHuman = formatUnits(capRaw, usdgDecimals);
    ok("usdgMaxAmount", `${capRaw.toString()} raw = ${capHuman} USDG`);
    const maxCap = process.env.PREFLIGHT_MAX_DEPOSIT_USDG?.trim();
    if (maxCap && Number(capHuman) > Number(maxCap)) {
      fail(
        "cap per deposit",
        `${capHuman} USDG melebihi PREFLIGHT_MAX_DEPOSIT_USDG=${maxCap}`,
      );
    }
  }

  if (
    process.env.TREASURY_ADDRESS &&
    treasury &&
    process.env.TREASURY_ADDRESS.toLowerCase() !== treasury.toLowerCase()
  ) {
    warn(
      "TREASURY_ADDRESS",
      "env berbeda dari treasury di mainnet.json; pastikan yang dipakai deploy adalah parameter file",
    );
  }
  if (
    process.env.USDG_TOKEN_ADDRESS &&
    usdg &&
    process.env.USDG_TOKEN_ADDRESS.toLowerCase() !== usdg.toLowerCase()
  ) {
    warn(
      "USDG_TOKEN_ADDRESS",
      "env berbeda dari usdgToken di mainnet.json; pastikan yang dipakai deploy adalah parameter file",
    );
  }

  console.log("");
  if (failed) {
    console.log("Hasil: NO-GO. Perbaiki item ✗ sebelum deploy mainnet.");
    process.exitCode = 1;
    return;
  }
  console.log("Hasil: GO. Preflight lulus; lanjutkan hanya dari commit yang disetujui.");
}

main().catch((error) => {
  console.error(
    "Preflight gagal:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
