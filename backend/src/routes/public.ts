import { Hono } from "hono";
import { getConfig, getParams } from "../config";
import { env } from "../env";
import { isRecipeAvailable } from "../orchestration/availability";
import { buildTokenRegistry } from "../onchain/registry";
import { buildPriceContext } from "../onchain/config";
import { priceForToken } from "../onchain/prices";
import { listEpochs } from "../burn/epochs";
import {
  burnedPercent,
  formatTokenAmount,
  getTokenBurnStats,
  listTokenBurns,
} from "../burn/token-burns";
import { getPublicHolderTiers } from "../holder/service";
import { getLeaderboardTop } from "../leaderboard/service";
import { leaderboardWeekSchema, serializeWeek, weekWindow } from "../leaderboard/week";
import { serializePublicRun } from "../serialize-public";
import { getPublicSharedRun } from "../services/shares";
import { getStats } from "../stats/service";
import { ApiError } from "../lib/http";

/**
 * Endpoint publik tanpa auth: konfigurasi top-up onchain yang dibutuhkan
 * frontend untuk membangun transaksi `deposit()` (Fase 2/4).
 *
 * Tidak ada data sensitif di sini (hanya alamat publik + parameter bisnis).
 */
export const publicRoutes = new Hono();

publicRoutes.get("/deposits/config", async (c) => {
  const params = getParams();
  const registry = buildTokenRegistry({
    gattaiTokenAddress: env.gattaiTokenAddress,
    usdgTokenAddress: env.usdgTokenAddress,
    usdgDecimals: env.usdgDecimals,
    enabledSymbols: env.depositEnabledSymbols,
  });

  const priceCtx = buildPriceContext();
  const tokens = await Promise.all(
    registry.all().map(async (token) => {
      let priceUsd: number | null = null;
      try {
        const p = await priceForToken(token, priceCtx);
        priceUsd = Number(p.price8) / 1e8;
      } catch {
        // Harga tidak tersedia / pending
      }
      return {
        symbol: token.symbol,
        address: token.address,
        decimals: token.decimals,
        price_usd: priceUsd,
      };
    }),
  );

  // Konfigurasi top-up berisi harga live; cache pendek agar tidak membebani
  // price provider tetapi tetap cepat berubah.
  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=30");

  return c.json({
    chain_id: env.chainId,
    deposit_manager: env.depositManagerAddress ?? null,
    treasury: env.treasuryAddress ?? null,
    gattai_token: env.gattaiTokenAddress ?? null,
    usdg_token: env.usdgTokenAddress ?? null,
    tokens,
    discount_ratio: params.gattai.discount_ratio,
    cap_usd: params.deposits.cap_usd,
    twap_window_minutes: params.deposits.twap_window_minutes,
    confirmations: env.depositConfirmations,
  });
});

/**
 * Satu run yang di-share. Tanpa auth; slug acak adalah kapabilitasnya.
 *
 * Serializer publik sengaja tidak memakai `serializeRun()`: tidak ada run id,
 * project id, step id, wallet, biaya provider, atau data internal lain.
 */
publicRoutes.get("/runs/:slug", async (c) => {
  const shared = await getPublicSharedRun(c.req.param("slug"));
  if (!shared) {
    throw new ApiError(404, "RUN_NOT_FOUND", "Run not found.");
  }

  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
  return c.json(serializePublicRun(shared, { mediaShareEnabled: env.mediaShareEnabled }));
});

/**
 * Peringkat mingguan publik. Hanya run SETTLED, cap 200/project/hari, top 20.
 * `me` sengaja selalu null: response ini di-cache per URL dan tidak boleh
 * berbeda antar sesi. Rank user login diambil dari `/v1/leaderboard/me`.
 */
publicRoutes.get("/leaderboard", async (c) => {
  const week = leaderboardWeekSchema.parse(c.req.query("week") ?? "current");
  const window = weekWindow(week);
  const entries = await getLeaderboardTop(window);
  const updatedAt = new Date();

  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=30");

  return c.json({
    week: serializeWeek(window),
    entries: entries.map((entry, index) => ({
      rank: index + 1,
      display_name: entry.displayName,
      runs: entry.runs,
      is_me: false,
    })),
    me: null,
    updated_at: updatedAt.toISOString(),
  });
});

/**
 * Agregasi statistik publik produk, revenue, token burn, dan kontrak onchain.
 * Cache publik 60 detik.
 */
publicRoutes.get("/stats", async (c) => {
  const stats = await getStats();
  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
  return c.json(stats);
});

/**
 * Definisi publik tingkatan tier holder, aturan snapshot, dan kuota harian.
 * Cache publik 300 detik.
 */
publicRoutes.get("/holder/tiers", (c) => {
  const data = getPublicHolderTiers();
  c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  return c.json(data);
});

/**
 * Statistik burn token GATTAI. Publik, tanpa auth.
 *
 * Sumber angka adalah `token_burns` (hasil indexer transfer ke dead address),
 * bukan hanya epoch `executed`. Dengan begitu burn tim/treasury dan burn
 * komunitas tetap terlihat, dan total = team + epoch + community.
 *
 * Semua jumlah base-unit dikirim sebagai string integer. Field desimal
 * (`*_tokens_burned`) disediakan untuk kompatibilitas & tampilan; frontend
 * tetap memakai `*_raw` + `token.decimals` agar tidak kehilangan presisi.
 */
publicRoutes.get("/burns", async (c) => {
  const [stats, burns, epochs] = await Promise.all([
    getTokenBurnStats(),
    listTokenBurns(200),
    listEpochs(50),
  ]);

  const decimals = env.burnTokenDecimals;
  const supplyRaw = env.burnTokenTotalSupply;
  const tokenAddress = env.burnTokenAddress ?? null;

  // Data publik boleh di-cache singkat; indexer berjalan tiap beberapa detik.
  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=30");

  return c.json({
    token: {
      address: tokenAddress,
      symbol: env.burnTokenSymbol,
      decimals,
      total_supply_raw: supplyRaw.toString(),
      total_supply: formatTokenAmount(supplyRaw, decimals),
    },
    total_tokens_burned: formatTokenAmount(stats.totalRaw, decimals),
    total_tokens_burned_raw: stats.totalRaw.toString(),
    team_tokens_burned: formatTokenAmount(stats.teamRaw, decimals),
    team_tokens_burned_raw: stats.teamRaw.toString(),
    epoch_tokens_burned: formatTokenAmount(stats.epochRaw, decimals),
    epoch_tokens_burned_raw: stats.epochRaw.toString(),
    community_tokens_burned: formatTokenAmount(stats.communityRaw, decimals),
    community_tokens_burned_raw: stats.communityRaw.toString(),
    burned_percent: burnedPercent(stats.totalRaw, supplyRaw),
    burn_counts: stats.counts,
    burns: burns.map((burn) => ({
      id: burn.id,
      tx_hash: burn.chainTx,
      log_index: burn.logIndex,
      block_number: burn.blockNumber,
      block_timestamp: burn.blockTimestamp?.toISOString() ?? null,
      from: burn.fromAddress,
      to: burn.toAddress,
      amount_raw: burn.amountRaw,
      amount: formatTokenAmount(BigInt(burn.amountRaw), burn.decimals),
      decimals: burn.decimals,
      kind: burn.kind,
      epoch_id: burn.epochId,
      created_at: burn.createdAt,
    })),
    epochs: epochs.map((epoch) => ({
      id: epoch.id,
      period_start: epoch.periodStart,
      period_end: epoch.periodEnd,
      budget_usd: epoch.budgetUsd,
      tokens_burned: epoch.tokensBurned,
      tx_hashes: epoch.txHashes,
      status: epoch.status,
      created_at: epoch.createdAt,
    })),
  });
});

/**
 * Ketersediaan formasi untuk pengunjung anonim (landing page).
 *
 * Landing memakai daftar formasi statis selama pengunjung belum login (tidak
 * memanggil `/v1/recipes` yang butuh sesi), jadi ia butuh sumber publik untuk
 * menandai kartu "coming soon". Isinya cermin dari field `available` di
 * `/v1/recipes`: hanya id + nama + boolean — tanpa nama provider/env.
 */
publicRoutes.get("/formations", (c) => {
  // Daftar formasi hanya berubah saat deploy/config reload; cache lebih lama.
  c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  return c.json({
    formations: getConfig().recipes.map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      available: isRecipeAvailable(recipe),
    })),
  });
});

/**
 * Kolektor laporan CSP (`report-uri` di `frontend/vercel.json`).
 *
 * Publik & tanpa auth: browser mengirim laporan sebagai `POST` dengan body
 * `application/csp-report` (JSON). Selalu balas `204` — kegagalan pelaporan
 * tidak boleh terlihat oleh pengguna. Hanya pelanggaran yang *terjadi* yang
 * bisa mengungkap host yang lupa dimasukkan ke CSP, jadi jalur ini yang
 * membuat policy ketat tetap bisa dipantau tanpa proxy pihak ketiga.
 */
const MAX_CSP_REPORT_BYTES = 8192;

publicRoutes.post("/csp-report", async (c) => {
  const raw = await c.req.text();
  // Batasi panjang: jalur ini terbuka, jangan sampai bisa membanjiri log.
  if (raw.length === 0 || raw.length > MAX_CSP_REPORT_BYTES) {
    return c.body(null, 204);
  }

  try {
    const parsed = JSON.parse(raw) as { "csp-report"?: Record<string, unknown> };
    const report = parsed["csp-report"];
    if (report) {
      console.warn(
        "[csp]",
        String(report["effective-directive"] ?? report["violated-directive"] ?? "unknown"),
        "blocked:",
        String(report["blocked-uri"] ?? "-"),
        "document:",
        String(report["document-uri"] ?? "-"),
      );
    }
  } catch {
    // Body bukan JSON (atau bukan format CSP): abaikan tanpa berisik.
  }

  return c.body(null, 204);
});
