import "dotenv/config";
import { getBalanceMicro, recordCreditLot } from "../src/billing/ledger";
import { db, pool } from "../src/db";
import { apiKeys } from "../src/db/schema";
import { generateApiKey, hashSecret } from "../src/lib/crypto";
import { newId } from "../src/lib/id";
import { creditsToMicro, microToCredits } from "../src/lib/money";
import { syncRecipes } from "../src/orchestration/create-run";
import { findOrCreateProjectByWallet } from "../src/services/projects";

/**
 * Menyiapkan data pengembangan tanpa onchain:
 *   - project untuk sebuah wallet (default wallet dev)
 *   - satu API key (secret dicetak sekali)
 *   - saldo credits awal (default 100 credits)
 *   - sinkronisasi recipe dari config
 *
 * Pemakaian:
 *   bun run seed:dev [wallet] [credits]
 */

const DEFAULT_WALLET = "0x000000000000000000000000000000000000dead";

async function main(): Promise<void> {
  const wallet = (process.argv[2] ?? DEFAULT_WALLET).toLowerCase();
  const credits = Number(process.argv[3] ?? 100);
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error("Jumlah credits harus angka positif.");
  }

  const recipeCount = await syncRecipes();

  const project = await findOrCreateProjectByWallet(wallet);

  const { secret, prefix } = generateApiKey();
  const key = await db
    .insert(apiKeys)
    .values({
      id: newId("key"),
      projectId: project.id,
      prefix,
      hash: hashSecret(secret),
      label: "seed-dev",
    })
    .returning();

  const micro = creditsToMicro(credits);
  const lot = await recordCreditLot({
    projectId: project.id,
    source: "PROMO",
    amountMicro: micro,
    idempotencyKey: `seed-dev:${project.id}`,
  });

  const balanceMicro = await getBalanceMicro(project.id);

  console.log("");
  console.log("GATTAI — seed pengembangan selesai");
  console.log("----------------------------------");
  console.log(`project_id   : ${project.id}`);
  console.log(`wallet       : ${project.ownerWallet}`);
  console.log(`api_key      : ${secret}`);
  console.log(`key_id       : ${key[0].id}`);
  console.log(`recipes      : ${recipeCount} disinkronkan`);
  console.log(
    `credits      : ${lot.applied ? `+${credits}` : "sudah pernah di-seed"} (saldo ${microToCredits(balanceMicro)})`,
  );
  console.log("");
  console.log("Coba:");
  console.log(
    `  curl -s http://localhost:3000/v1/balance -H "Authorization: Bearer ${secret}"`,
  );
  console.log("");
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("seed gagal:", error instanceof Error ? error.message : error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
