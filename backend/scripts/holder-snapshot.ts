/**
 * Jalankan satu siklus snapshot holder dari CLI.
 *
 * Berguna untuk:
 * - verifikasi cepat setelah deploy / migrasi;
 * - memaksa snapshot setelah RPC pulih tanpa menunggu jadwal worker;
 * - mengambil snapshot wallet tertentu saat investigasi.
 *
 * Contoh:
 *   bun run holder:snapshot --wallet 0xabc... --force
 *   bun run holder:snapshot --max 50 --force
 *
 * Tanpa `--force`, guard last-success yang sama dengan worker tetap berlaku.
 * CLI tidak membuka endpoint HTTP dan tidak mencetak alamat wallet.
 */

import "dotenv/config";
import { pool } from "../src/db";
import { assertProductionConfig } from "../src/env";
import { runHolderSnapshotCycle } from "../src/holder/snapshot-worker";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function usage(): string {
  return [
    "Usage: bun run holder:snapshot [options]",
    "",
    "Options:",
    "  --wallet <0x...>   Batasi ke wallet tertentu (boleh diulang / dipisah koma).",
    "  --max <n>          Batasi jumlah wallet yang dipindai (0 = semua).",
    "  --force            Abaikan guard last-success.",
    "  --help             Tampilkan bantuan ini.",
  ].join("\n");
}

function parseArgs(argv: string[]): {
  wallets: string[];
  maxWallets: number;
  force: boolean;
  help: boolean;
} {
  const wallets: string[] = [];
  let maxWallets = 0;
  let force = false;
  let help = false;

  const addWallets = (raw: string) => {
    for (const part of raw.split(",")) {
      const wallet = part.trim();
      if (!wallet) continue;
      if (!ADDRESS_RE.test(wallet)) {
        throw new Error(`Invalid wallet address: ${wallet}`);
      }
      wallets.push(wallet.toLowerCase());
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--wallet") {
      const value = argv[index + 1];
      if (!value) throw new Error("--wallet requires a value.");
      addWallets(value);
      index += 1;
    } else if (arg.startsWith("--wallet=")) {
      addWallets(arg.slice("--wallet=".length));
    } else if (arg === "--max") {
      const value = argv[index + 1];
      if (!value) throw new Error("--max requires a value.");
      maxWallets = Number(value);
      index += 1;
    } else if (arg.startsWith("--max=")) {
      maxWallets = Number(arg.slice("--max=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(maxWallets) || maxWallets < 0) {
    throw new Error("--max must be a non-negative integer.");
  }

  return { wallets, maxWallets, force, help };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  assertProductionConfig();
  const result = await runHolderSnapshotCycle({
    wallets: args.wallets.length > 0 ? args.wallets : undefined,
    maxWallets: args.maxWallets,
    force: args.force,
  });
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(
    "[holder:snapshot]",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
