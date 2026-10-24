import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db";

const here = fileURLToPath(new URL(".", import.meta.url));
const migrationFile = join(here, "..", "src", "db", "migrations", "0015_daffy_skrulls.sql");

async function main() {
  console.log("Connecting with DATABASE_URL:", process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@"));
  const sql = readFileSync(migrationFile, "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed) {
      try {
        await pool.query(trimmed);
        console.log("Applied:", trimmed.slice(0, 50).replace(/\n/g, " "));
      } catch (err) {
        console.error("Error executing:", trimmed.slice(0, 50), err);
      }
    }
  }
  const check = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'holder_%'",
  );
  console.log("Holder tables present:", check.rows.map((r) => r.table_name));
  await pool.end();
}

main().catch(console.error);
