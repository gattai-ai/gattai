import "dotenv/config";
import pg from "pg";

const raw = process.env.DATABASE_URL;
if (!raw) throw new Error("DATABASE_URL tidak diset");

const url = new URL(raw);
const target = url.pathname.replace(/^\//, "");
if (!target) throw new Error("Nama database tidak ditemukan di DATABASE_URL");

url.pathname = "/postgres";
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();

const existing = await client.query("select 1 from pg_database where datname = $1", [target]);
if (existing.rowCount) {
  console.log("DB sudah ada:", target);
} else {
  await client.query(`create database "${target}"`);
  console.log("DB dibuat:", target);
}

await client.end();
process.exit(0);
