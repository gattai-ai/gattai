/**
 * Doctor top-up: memeriksa apakah alur deposit onchain bisa berjalan, dan
 * kalau tidak, penyebab kegagalannya secara spesifik.
 *
 * Ini sengaja read-only (tidak menulis ke DB/chain) supaya aman dijalankan
 * kapan saja — termasuk sebelum tes manual.
 *
 * Pemakaian:
 *   bun run doctor:deposit
 *
 * Keluarannya daftar check dengan status OK / GAGAL / INFO. Keluar dengan
 * kode 1 bila ada check GAGAL, sehingga bisa dipakai sebagai gate CI/smoke test.
 */

import "dotenv/config";
import { createPublicClient, http, type PublicClient } from "viem";
import { pool } from "../src/db";
import { env, isProd } from "../src/env";
import { buildTokenRegistry } from "../src/onchain/registry";
import { priceForToken, PriceUnavailableError } from "../src/onchain/prices";
import { buildPriceContext } from "../src/onchain/config";
import { depositManagerAbi } from "../../shared/contracts/abis/DepositManager";
import { gattaiTokenAbi } from "../../shared/contracts/abis/GattaiToken";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type Level = "ok" | "fail" | "warn" | "info";

interface Check {
  level: Level;
  name: string;
  detail: string;
  hint?: string;
}

const checks: Check[] = [];

function ok(name: string, detail: string): void {
  checks.push({ level: "ok", name, detail });
}
function fail(name: string, detail: string, hint?: string): void {
  checks.push({ level: "fail", name, detail, hint });
}
function warn(name: string, detail: string, hint?: string): void {
  checks.push({ level: "warn", name, detail, hint });
}
function info(name: string, detail: string): void {
  checks.push({ level: "info", name, detail });
}

/** Uji satu endpoint RPC dengan `eth_blockNumber`. */
async function probeRpc(url: string, timeoutMs: number): Promise<{ ok: boolean; block?: bigint; error?: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json()) as { result?: string; error?: { message?: string } };
    if (body.error) return { ok: false, error: body.error.message ?? "JSON-RPC error" };
    if (!body.result) return { ok: false, error: `respons tidak punya result (HTTP ${response.status})` };
    return { ok: true, block: BigInt(body.result) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkRpc(): Promise<PublicClient | null> {
  const primary = env.robinhoodRpcUrl;
  if (!primary) {
    fail("RPC utama", "ROBINHOOD_RPC_URL belum diisi", "Isi endpoint RPC testnet/mainnet di backend/.env");
    return null;
  }

  const urls = [primary, ...env.robinhoodRpcFallbackUrls];
  const results = [];
  for (const url of urls) {
    const result = await probeRpc(url, env.rpcTimeoutMs);
    results.push({ url, ...result });
    if (result.ok) {
      ok("RPC dapat dihubungi", `${url} → head ${result.block}`);
    } else {
      fail("RPC tidak dapat dihubungi", `${url} → ${result.error}`);
    }
  }

  const working = results.find((item) => item.ok);
  if (!working) {
    fail(
      "RPC used by backend",
      "Semua endpoint gagal — `/v1/deposits/confirm` dan reconciler tidak bisa jalan.",
      "Cek DNS/firewall. Catatan: rpc.testnet.chain.robinhood.com diblokir di beberapa jaringan (Indonesia).",
    );
    return null;
  }

  if (!results[0].ok) {
    warn(
      "RPC utama tidak jalan",
      `Endpoint utama gagal, memakai fallback ${working.url}.`,
      "Ganti ROBINHOOD_RPC_URL ke endpoint yang working agar tidak bergantung pada fallback.",
    );
  }

  // Deteksi kursor yang tertinggal jauh di belakang head.
  const head = working.block!;
  const fromBlock = env.indexerFromBlock;
  if (fromBlock !== undefined && fromBlock > head) {
    fail(
      "INDEXER_FROM_BLOCK",
      `Blok ${fromBlock} > head ${head}. Reconciler akan idle selamanya.`,
      "Isi blok ≤ head, atau kosongkan agar mulai dari head.",
    );
  } else if (fromBlock !== undefined && head - fromBlock > 1_000_000n) {
    warn(
      "INDEXER_FROM_BLOCK",
      `Catch-up ${head - fromBlock} blok bisa memicu rate limit RPC.`,
      "Naikkan blok closer ke head, atau andalkan `bun run indexer --from-block=<N>`.",
    );
  }

  return createPublicClient({ chain: undefined as never, transport: http(working.url) });
}

async function checkContracts(client: PublicClient): Promise<void> {
  const manager = env.depositManagerAddress;
  if (!manager || !ADDRESS_RE.test(manager)) {
    fail("DepositManager address", "DEPOSIT_MANAGER_ADDRESS belum diisi/invalid", "Isi alamat hasil deploy testnet");
    return;
  }

  const code = await client.getCode({ address: manager as `0x${string}` });
  if (!code || code === "0x") {
    fail("DepositManager ter-deploy", `Tidak ada bytecode di ${manager}`, "Alamat salah / belum deploy di chain ini");
    return;
  }
  ok("DepositManager ter-deploy", manager);

  const treasury = (await client.readContract({
    address: manager as `0x${string}`,
    abi: depositManagerAbi,
    functionName: "treasury",
  })) as string;
  if (env.treasuryAddress && treasury.toLowerCase() !== env.treasuryAddress.toLowerCase()) {
    fail("Treasury onchain", `Kontrak ${treasury} ≠ env ${env.treasuryAddress}`, "Selaraskan TREASURY_ADDRESS");
  } else {
    ok("Treasury onchain", treasury);
  }

  const paused = await client.readContract({
    address: manager as `0x${string}`,
    abi: depositManagerAbi,
    functionName: "paused",
  });
  if (paused) {
    fail("DepositManager paused", "Kontrak sedang di-pause — semua deposit revert", "Treasury harus panggil unpause()");
  } else {
    ok("DepositManager paused", "tidak (deposit diterima)");
  }

  const owner = (await client.readContract({
    address: manager as `0x${string}`,
    abi: depositManagerAbi,
    functionName: "owner",
  })) as string;
  info("DepositManager owner", `${owner} (bisa setTokenAccepted / pause)`);

  // Allowlist per token ERC-20 yang dikonfigurasi.
  const registry = buildTokenRegistry({
    gattaiTokenAddress: env.gattaiTokenAddress,
    usdgTokenAddress: env.usdgTokenAddress,
    usdgDecimals: env.usdgDecimals,
    enabledSymbols: env.depositEnabledSymbols,
  });

  for (const token of registry.all()) {
    if (token.address === "0x0000000000000000000000000000000000000000") {
      ok("Token ETH native", "selalu diterima (tidak perlu allowlist)");
      continue;
    }
    const accepted = await client.readContract({
      address: manager as `0x${string}`,
      abi: depositManagerAbi,
      functionName: "acceptedToken",
      args: [token.address as `0x${string}`],
    });
    if (!accepted) {
      fail(
        `Allowlist ${token.symbol}`,
        `${token.address} belum di-allowlist → deposit ${token.symbol} akan revert TokenNotAccepted`,
        `Treasury harus memanggil setTokenAccepted("${token.address}", true)`,
      );
    } else {
      ok(`Allowlist ${token.symbol}`, token.address);
    }
  }

  const gattai = env.gattaiTokenAddress;
  if (gattai && ADDRESS_RE.test(gattai)) {
    const code2 = await client.getCode({ address: gattai as `0x${string}` });
    if (!code2 || code2 === "0x") {
      fail("GattaiToken ter-deploy", `Tidak ada bytecode di ${gattai}`, "Alamat token salah");
      return;
    }
    ok("GattaiToken ter-deploy", gattai);
    const tokenOwner = (await client.readContract({
      address: gattai as `0x${string}`,
      abi: gattaiTokenAbi,
      functionName: "owner",
    })) as string;
    if (tokenOwner.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
      warn("GattaiToken ownership", `owner = ${tokenOwner}, belum renounce`, "Brief mewajibkan renounce setelah deploy");
    } else {
      ok("GattaiToken ownership", "renounce (owner = 0)");
    }
  }
}

async function checkPrices(client: PublicClient | null): Promise<void> {
  const registry = buildTokenRegistry({
    gattaiTokenAddress: env.gattaiTokenAddress,
    usdgTokenAddress: env.usdgTokenAddress,
    usdgDecimals: env.usdgDecimals,
    enabledSymbols: env.depositEnabledSymbols,
  });
  const ctx = buildPriceContext(client ?? undefined);

  for (const token of registry.all()) {
    try {
      const price = await priceForToken(token, ctx);
      ok(`Harga ${token.symbol}`, `${Number(price.price8) / 1e8} USD (${price.source})`);
    } catch (error) {
      if (error instanceof PriceUnavailableError) {
        fail(`Harga ${token.symbol}`, `tidak tersedia → deposit ${token.symbol} tertahan "pending"`, error.message);
      } else {
        fail(`Harga ${token.symbol}`, error instanceof Error ? error.message : String(error));
      }
    }
  }
}

async function checkDb(): Promise<void> {
  if (!env.databaseUrl) {
    fail("DATABASE_URL", "belum diisi — kredit deposit tidak bisa disimpan");
    return;
  }
  try {
    const result = await pool.query<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_name in ('deposits','credit_lots','chain_cursors')",
    );
    const count = result.rows[0]?.n ?? 0;
    if (count < 3) {
      fail("Migrasi database", `hanya ${count}/3 tabel kunci ada`, "Jalankan `bun run --cwd backend db:migrate`");
    } else {
      ok("Migrasi database", "deposits + credit_lots + chain_cursors ada");
    }
  } catch (error) {
    fail("Koneksi database", error instanceof Error ? error.message : String(error), "Cek DATABASE_URL");
  }
}

function checkConfig(): void {
  const mainnet = env.chainId === 4663;
  const minConfirmations = mainnet ? 60 : 1;
  if (env.depositConfirmations < minConfirmations) {
    fail(
      "DEPOSIT_CONFIRMATIONS",
      `${env.depositConfirmations} (minimum mainnet ${minConfirmations})`,
      "Mainnet Fase 1 wajib ≥ 60; testnet boleh 1–3",
    );
  } else if (!mainnet && env.depositConfirmations === 1) {
    warn("DEPOSIT_CONFIRMATIONS", "1 (cuma untuk testnet)", "Mainnet wajib ≥ 60");
  } else {
    ok("DEPOSIT_CONFIRMATIONS", String(env.depositConfirmations));
  }
  if (env.indexerReorgLookback <= env.depositConfirmations) {
    fail(
      "INDEXER_REORG_LOOKBACK",
      `${env.indexerReorgLookback} <= ${env.depositConfirmations}`,
      "Set lebih besar dari DEPOSIT_CONFIRMATIONS",
    );
  } else {
    ok("INDEXER_REORG_LOOKBACK", String(env.indexerReorgLookback));
  }

  if (isProd()) {
    if (!env.allowManualPrices) {
      ok("Harga manual", "dimatikan (produksi)");
    } else {
      warn("Harga manual", "AKTIF di produksi", "Jangan pakai ALLOW_MANUAL_PRICES di produksi");
    }
    if (env.sessionSecret === "dev-insecure-session-secret" || env.sessionSecret === "change-me-to-a-long-random-string") {
      fail("SESSION_SECRET", "masih nilai contoh", "Ganti dengan string acak panjang di produksi");
    }
  }

  if (!env.indexerEnabled) {
    info("Reconciler in-process", "dimatikan (INDEXER_ENABLED=false) — andalkan POST /v1/deposits/confirm + `bun run indexer`");
  }

  const capHint = env.depositMinUsd > 0 ? ` (DEPOSIT_MIN_USD=$${env.depositMinUsd})` : "";
  info("Ambang dust", capHint || "tidak ada");
}

async function main(): Promise<void> {
  console.log("=== GATTAI doctor: top-up onchain ===\n");
  console.log(`chain id      : ${env.chainId}`);
  console.log(`NODE_ENV      : ${process.env.NODE_ENV ?? "(unset)"}`);
  console.log(`deposit mgr   : ${env.depositManagerAddress ?? "(kosong)"}\n`);

  checkConfig();
  const client = await checkRpc();
  if (client) await checkContracts(client);
  await checkPrices(client);
  await checkDb();

  const icon: Record<Level, string> = { ok: "OK  ", fail: "GAGAL", warn: "WARN", info: "INFO" };
  console.log("");
  for (const check of checks) {
    console.log(`[${icon[check.level]}] ${check.name}: ${check.detail}`);
    if (check.hint && check.level !== "ok") console.log(`       → ${check.hint}`);
  }

  const failures = checks.filter((check) => check.level === "fail");
  const warnings = checks.filter((check) => check.level === "warn");
  console.log(
    `\nRingkasan: ${checks.length - failures.length - warnings.length} ok, ${warnings.length} warn, ${failures.length} gagal`,
  );
  if (failures.length > 0) {
    console.log("\nTop-up TIDAK akan berfungsi sampai check GAGAL diperbaiki.");
    process.exitCode = 1;
  } else {
    console.log("\nTop-up siap. Deposit ETH/USDG yang tersedia harus langsung dikreditkan.");
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(async (error) => {
    console.error("doctor gagal:", error instanceof Error ? error.message : error);
    await pool.end().catch(() => {});
    process.exit(1);
  });