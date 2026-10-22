/**
 * Deploy Fase 1 mainnet dengan guard:
 * 1. Wajib `CONFIRM_MAINNET_DEPLOY=4663`.
 * 2. Preflight harus GO.
 * 3. Baru menjalankan Ignition `deploy:phase1:mainnet`.
 *
 * Pemakaian:
 *   CONFIRM_MAINNET_DEPLOY=4663 MAINNET_DEPLOYER_PRIVATE_KEY=0x... \
 *     bun run --cwd contracts deploy:phase1:mainnet:guarded
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

if (process.env.CONFIRM_MAINNET_DEPLOY !== "4663") {
  console.error(
    "Deploy mainnet diblokir. Set CONFIRM_MAINNET_DEPLOY=4663 hanya setelah preflight GO dan approval eksplisit.",
  );
  process.exit(1);
}

function run(args: string[]): void {
  const result = spawnSync("bun", args, {
    cwd: dirname(scriptDir),
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("Menjalankan preflight mainnet...");
run(["scripts/mainnet-preflight.ts"]);

console.log("Preflight GO. Menjalankan deploy Fase 1...");
run([
  "run",
  "deploy:phase1:mainnet",
]);
