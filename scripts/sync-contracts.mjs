import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = join(root, "contracts");
const outDir = join(root, "shared", "contracts");
const names = process.argv.slice(2);

if (names.length === 0) {
  console.error("Pemakaian: node scripts/sync-contracts.mjs Counter [NamaKontrak2 ...]");
  process.exit(1);
}

// 1) ABI dari artifact Hardhat -> shared/contracts/abis/<Nama>.ts
const abisDir = join(outDir, "abis");
mkdirSync(abisDir, { recursive: true });

for (const name of names) {
  const artifact = join(contractsDir, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  if (!existsSync(artifact)) {
    console.error(
      `Artifact tidak ditemukan: ${artifact}\nJalankan build dulu, atau sesuaikan path.`,
    );
    process.exit(1);
  }
  const { abi } = JSON.parse(readFileSync(artifact, "utf8"));
  const varName = name[0].toLowerCase() + name.slice(1) + "Abi";
  writeFileSync(
    join(abisDir, `${name}.ts`),
    `// File ini dibuat otomatis oleh scripts/sync-contracts.mjs - jangan diedit manual.\nexport const ${varName} = ${JSON.stringify(abi, null, 2)} as const;\n`,
  );
}

const abiFiles = readdirSync(abisDir)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".d.ts"))
  .map((f) => f.replace(/\.ts$/, ""))
  .sort();

writeFileSync(
  join(abisDir, "index.ts"),
  "// File ini dibuat otomatis oleh scripts/sync-contracts.mjs - jangan diedit manual.\n" +
    abiFiles.map((f) => `export * from "./${f}";`).join("\n") +
    "\n",
);

// 2) Alamat hasil deploy Ignition -> shared/contracts/addresses.ts
//
// Kunci Ignition berbentuk "CounterModule#Counter". Nama kontrak bisa muncul
// dari beberapa modul (mis. GattaiModule#DepositManager legacy dan
// DepositManagerModule#DepositManager Fase 1). Jangan memakai "last wins"
// implisit; pilih modul kanonik secara eksplisit agar hasil sync deterministik.
const PREFERRED_MODULE_BY_NAME = {
  DepositManager: "DepositManagerModule",
  GattaiToken: "GattaiModule",
  MockUSDG: "MockUsdgModule",
};

const addresses = {};
const deploymentsDir = join(contractsDir, "ignition", "deployments");

if (existsSync(deploymentsDir)) {
  for (const dir of readdirSync(deploymentsDir)) {
    const match = dir.match(/^chain-(\d+)$/);
    if (!match) continue;

    const file = join(deploymentsDir, dir, "deployed_addresses.json");
    if (!existsSync(file)) continue;

    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object") continue;

    const byName = new Map();
    for (const [key, value] of Object.entries(raw)) {
      const separator = key.indexOf("#");
      if (separator === -1) continue;
      const moduleName = key.slice(0, separator);
      const contractName = key.slice(separator + 1);
      const entries = byName.get(contractName) ?? [];
      entries.push({ moduleName, address: value });
      byName.set(contractName, entries);
    }

    const chainAddresses = {};
    for (const [contractName, entries] of byName) {
      const preferredModule = PREFERRED_MODULE_BY_NAME[contractName];
      const preferred = preferredModule
        ? entries.find((entry) => entry.moduleName === preferredModule)
        : undefined;

      if (preferred) {
        chainAddresses[contractName] = preferred.address;
        continue;
      }

      if (entries.length > 1) {
        console.warn(
          `Peringatan: ${contractName} muncul dari beberapa modul di chain ${match[1]}: ` +
            entries.map((entry) => entry.moduleName).join(", ") +
            `; memakai entri terakhir. Tambahkan modul kanonik ke PREFERRED_MODULE_BY_NAME.`,
        );
      }
      chainAddresses[contractName] = entries[entries.length - 1].address;
    }

    addresses[match[1]] = chainAddresses;
  }
}

writeFileSync(
  join(outDir, "addresses.ts"),
  `// File ini dibuat otomatis oleh scripts/sync-contracts.mjs - jangan diedit manual.\nexport const addresses = ${JSON.stringify(addresses, null, 2)} as const;\n`,
);

console.log("Sinkronisasi selesai:", { abi: abiFiles, chains: Object.keys(addresses) });
