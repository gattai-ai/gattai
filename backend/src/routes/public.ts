import { Hono } from "hono";
import { getConfig, getParams } from "../config";
import { env } from "../env";
import { isRecipeAvailable } from "../orchestration/availability";
import { buildTokenRegistry } from "../onchain/registry";
import { buildPriceContext } from "../onchain/config";
import { priceForToken } from "../onchain/prices";
import { burnedTotalTokens, listEpochs } from "../burn/epochs";

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
 * Statistik buyback & burn (Fase 3). Publik, tanpa auth.
 * Menampilkan total GATTAI terbakar (epoch `executed`) + rincian per epoch.
 */
publicRoutes.get("/burns", async (c) => {
  const [total, epochs] = await Promise.all([burnedTotalTokens(), listEpochs(50)]);
  return c.json({
    total_tokens_burned: total,
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
