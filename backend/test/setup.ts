import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Preload `bun test`: menyiapkan database uji yang bersih.
 *
 *  1. Menurunkan URL database uji (TEST_DATABASE_URL, atau DATABASE_URL + `_test`).
 *  2. Membuat database bila belum ada.
 *  3. Drop schema public + menerapkan seluruh migrasi dari `src/db/migrations`.
 *
 * Dengan begitu test berjalan deterministik dan tidak menyentuh database dev.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const migrationsDir = join(here, "..", "src", "db", "migrations");

function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error("DATABASE_URL wajib untuk menjalankan test (atau set TEST_DATABASE_URL).");
  }
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}_test`;
  return url.toString();
}

const target = new URL(testDatabaseUrl());
const dbName = target.pathname.replace(/^\//, "");

// 1. Pastikan database ada (hubungkan ke database maintenance `postgres`).
const adminUrl = new URL(target.toString());
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
if (!exists.rowCount) await admin.query(`create database "${dbName}"`);
await admin.end();

// 2. Arahkan semua impor berikutnya ke database uji.
process.env.DATABASE_URL = target.toString();
process.env.SIWE_DOMAIN ||= "localhost:3000";
// Origin frontend deterministik: membuat CORS + penjaga CSRF bisa diuji
// (tanpa ini `FRONTEND_URL` kosong → wildcard → penjaga jadi no-op).
process.env.FRONTEND_URL ||= "http://localhost:5173";
process.env.PROVIDER_RETRY_ATTEMPTS ||= "2";
process.env.PROVIDER_TIMEOUT_MS ||= "5000";
// Provider selalu di-mock di test; isi key dummy agar adapter tidak melempar
// sebelum sampai ke fetch.
process.env.ANTHROPIC_API_KEY ||= "test-anthropic";
process.env.OPENAI_API_KEY ||= "test-openai";
process.env.PERPLEXITY_API_KEY ||= "test-perplexity";
process.env.HIGGSFIELD_API_KEY ||= "test-higgsfield";
process.env.MIMO_API_KEY ||= "test-mimo";
process.env.MIMO_API_URL ||= "https://token-plan-sgp.xiaomimimo.com/v1";
// Test kuota butuh anggaran teks DAN media yang cukup untuk membuktikan kedua
// anggaran tidak saling makan. Default produksi (3 teks / 0 media) tetap
// diuji terpisah lewat assertProductionConfig; jangan bergantung pada .env
// lokal supaya hasil test deterministik.
process.env.TRIAL_FREE_RUNS = "10";
process.env.TRIAL_MAX_ATTEMPTS = "30";
process.env.TRIAL_FREE_MEDIA_ATTEMPTS = "2";
// Route deposit membalas 503 bila `DEPOSIT_MANAGER_ADDRESS` kosong, sehingga test
// akan bergantung pada `.env` lokal. Isi alamat testnet yang valid supaya test
// deterministik di CI, laptop baru, atau mesin tanpa `.env`.
process.env.DEPOSIT_MANAGER_ADDRESS ||= "0x31d02e01406bf31dF857fD65865E03d4dD5ab82a";
process.env.DEPOSIT_TREASURY_ADDRESS ||= "0x3b113D111672F8cc2e060F028EF4fF0B886dE63E";

// 3. Schema bersih + migrasi.
const client = new pg.Client({ connectionString: target.toString() });
await client.connect();
await client.query("drop schema if exists public cascade; create schema public;");

const files = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await client.query(trimmed);
  }
}
await client.end();
