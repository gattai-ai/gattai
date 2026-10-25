/**
 * Akses environment terpusat.
 *
 * Secret provider dibaca secara lazy (saat dipakai) supaya server tetap bisa
 * start dan `/health` tetap jalan tanpa kredensial lengkap — berguna untuk
 * smoke test lokal.
 */

import { MAINNET_CONTRACTS } from "@web3-starter/shared";
import { getParams } from "./config";

/**
 * Environment variable yang wajib ada tetapi belum diisi.
 *
 * Tipe khusus (bukan `Error` polos) supaya jalur run bisa memetakannya ke pesan
 * publik: nama variabel adalah detail internal dan tidak boleh tampil di UI.
 */
export class MissingEnvError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`Missing required environment variable: ${variable}`);
    this.name = "MissingEnvError";
    this.variable = variable;
  }
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new MissingEnvError(name);
  }
  return value;
}

/**
 * Baca angka dari env dengan validasi ketat.
 *
 * `Number("abc")` adalah `NaN`, dan `Math.max(1, NaN)` tetap `NaN`. Nilai NaN
 * lalu lolos ke setTimeout/limit dan berperilaku seperti "tanpa batas" atau
 * "langsung", tergantung pemakaian — footgun yang sulit dilacak. Env yang
 * diisi tetapi bukan angka sekarang gagal saat dibaca, bukan diam-diam salah.
 */
function numberEnv(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (opts.integer && !Number.isInteger(value))) {
    throw new Error(`Environment variable ${name} must be a finite${opts.integer ? " integer" : " number"}.`);
  }
  const min = opts.min ?? -Infinity;
  const max = opts.max ?? Infinity;
  return Math.min(max, Math.max(min, value));
}

/** Alamat mainnet Robinhood Chain dan USDG resmi (lihat docs/deployment). */
const MAINNET_CHAIN_ID = 4663;
const CANONICAL_MAINNET_USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function assertAddress(name: string, value: string | undefined): string {
  if (!value || !ADDRESS_RE.test(value)) {
    throw new Error(`${name} must be a valid 0x-prefixed 20-byte address.`);
  }
  return value;
}

/** Daftar aset top-up yang diizinkan. Produksi default USDG-only. */
export function parseDepositSymbols(raw: string | undefined, prod: boolean): Set<string> {
  const fallback = prod ? ["USDG"] : ["ETH", "USDG", "GATTAI"];
  const entries = (raw && raw.trim() !== "" ? raw.split(",") : fallback)
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
  const allowed = new Set(["ETH", "USDG", "GATTAI"]);
  for (const entry of entries) {
    if (!allowed.has(entry)) {
      throw new Error(
        `DEPOSIT_ENABLED_SYMBOLS contains unsupported asset "${entry}" (allowed: ETH, USDG, GATTAI).`,
      );
    }
  }
  if (entries.length === 0) {
    throw new Error("DEPOSIT_ENABLED_SYMBOLS must contain at least one asset.");
  }
  return new Set(entries);
}

/**
 * Preflight produksi: gagal sebelum server menerima trafik bila konfigurasi
 * mainnet tidak konsisten. Dipanggil dari `index.ts`, bukan saat impor modul,
 * supaya test dan CLI tetap bisa membaca env parsial.
 */
export function assertProductionConfig(): void {
  if (!isProd()) return;

  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required when NODE_ENV=production.");
  }
  if (env.chainId !== MAINNET_CHAIN_ID) {
    throw new Error(
      `CHAIN_ID must be ${MAINNET_CHAIN_ID} (Robinhood Chain mainnet) when NODE_ENV=production.`,
    );
  }

  // Token snapshot holder sengaja terpisah dari BURN_TOKEN_ADDRESS: mengubah
  // konfigurasi burn tidak boleh mengubah token yang menentukan tier.
  assertAddress("HOLDER_TOKEN_ADDRESS", env.holderTokenAddress);
  const holder = getParams().holder;
  if (holder.enabled && !env.robinhoodRpcUrl) {
    throw new Error("ROBINHOOD_RPC_URL is required when holder runs are enabled.");
  }
  // Snapshot holder harus membaca block yang sudah terkonfirmasi, bukan head.
  // Default 60 mengikuti finalitas deposit; staging boleh lebih rendah.
  if (env.holderSnapshotConfirmations < 12) {
    throw new Error("HOLDER_SNAPSHOT_CONFIRMATIONS must be >= 12 on mainnet.");
  }

  // Override menit hanya untuk staging/verifikasi cepat. Produksi wajib
  // memakai interval jam dan jarak tier 12 jam agar aturan anti-flash-loan
  // tidak melemah tanpa sengaja.
  if (holder.snapshot_interval_minutes !== undefined) {
    throw new Error(
      "HOLDER_SNAPSHOT_INTERVAL_MINUTES is staging-only and must not be set in production.",
    );
  }
  if (holder.tier_min_gap_minutes !== undefined) {
    throw new Error(
      "HOLDER_TIER_MIN_GAP_MINUTES is staging-only and must not be set in production.",
    );
  }
  const effectiveMinIntervalHours =
    holder.snapshot_interval_hours * (1 - holder.snapshot_jitter_ratio);
  if (effectiveMinIntervalHours <= 12) {
    throw new Error(
      "HOLDER_SNAPSHOT_INTERVAL_HOURS is too short: interval minus jitter must be > 12h so two consecutive snapshots can satisfy the holder tier gap.",
    );
  }

  const depositManager = assertAddress("DEPOSIT_MANAGER_ADDRESS", env.depositManagerAddress);
  assertAddress("TREASURY_ADDRESS", env.treasuryAddress);
  const usdg = assertAddress("USDG_TOKEN_ADDRESS", env.usdgTokenAddress);
  const allowUnverifiedUsdg = process.env.ALLOW_UNVERIFIED_USDG === "true";
  if (allowUnverifiedUsdg) {
    throw new Error(
      "ALLOW_UNVERIFIED_USDG must not be enabled during Phase 1 (USDG-only canonical token).",
    );
  }
  if (usdg.toLowerCase() !== CANONICAL_MAINNET_USDG) {
    throw new Error(
      `USDG_TOKEN_ADDRESS does not match the canonical Robinhood mainnet USDG (${CANONICAL_MAINNET_USDG}).`,
    );
  }
  if (env.usdgDecimals !== 6) {
    throw new Error("USDG_DECIMALS must be 6 on Robinhood mainnet.");
  }

  // Fase 1 memakai 60 konfirmasi. Nilai lebih rendah hanya boleh untuk
  // testnet/staging, bukan produksi mainnet.
  const confirmations = env.depositConfirmations;
  if (confirmations < 60) {
    throw new Error("DEPOSIT_CONFIRMATIONS must be >= 60 on mainnet.");
  }
  const indexerFromBlock = env.indexerFromBlock;
  if (indexerFromBlock === undefined || indexerFromBlock <= 0n) {
    throw new Error(
      "INDEXER_FROM_BLOCK is required on mainnet and must be > 0: use the DepositManager deployment block, not the current head.",
    );
  }
  if (env.indexerEnabled && !env.robinhoodRpcUrl) {
    throw new Error("ROBINHOOD_RPC_URL is required when the deposit indexer is enabled.");
  }
  if (env.indexerReorgLookback <= confirmations) {
    throw new Error(
      "INDEXER_REORG_LOOKBACK must be greater than DEPOSIT_CONFIRMATIONS on mainnet.",
    );
  }

  const symbols = parseDepositSymbols(process.env.DEPOSIT_ENABLED_SYMBOLS, true);
  if (symbols.has("ETH") && !env.chainlinkEthUsdFeed) {
    throw new Error(
      "ETH deposits are enabled but CHAINLINK_ETH_USD_FEED is empty. Disable ETH or configure the feed.",
    );
  }
  if (symbols.has("GATTAI") && !env.gattaiTwapPool) {
    throw new Error(
      "GATTAI deposits are enabled but GATTAI_TWAP_POOL is empty. Disable GATTAI until TWAP is ready.",
    );
  }
  if ([...symbols].some((symbol) => symbol !== "USDG")) {
    throw new Error(
      "Phase 1 production only supports USDG deposits. Set DEPOSIT_ENABLED_SYMBOLS=USDG.",
    );
  }

  if (env.gattaiTokenAddress) {
    throw new Error("GATTAI_TOKEN_ADDRESS must be empty during Phase 1 (USDG-only).");
  }
  if (env.burnExecute) {
    throw new Error("BURN_EXECUTE must be false during Phase 1 (buyback/burn is disabled).");
  }

  // Burn indexer membaca transfer token ke dead address. Konfigurasi ini
  // terpisah dari deposit GATTAI (yang tetap USDG-only di Phase 1).
  if (env.burnTokenAddress) {
    assertAddress("BURN_TOKEN_ADDRESS", env.burnTokenAddress);
    // Baca getter yang memvalidasi format env (desimal & total supply).
    const burnDecimals = env.burnTokenDecimals;
    const burnSupply = env.burnTokenTotalSupply;
    if (burnDecimals > 36 || burnSupply <= 0n) {
      throw new Error("BURN_TOKEN_DECIMALS/BURN_TOKEN_TOTAL_SUPPLY is invalid.");
    }
    for (const address of env.burnDeadAddresses) {
      assertAddress("BURN_DEAD_ADDRESSES", address);
    }
    for (const address of env.teamBurnWallets) {
      assertAddress("TEAM_BURN_WALLETS", address);
    }
    if (env.burnIndexerEnabled) {
      if (!env.robinhoodRpcUrl) {
        throw new Error("ROBINHOOD_RPC_URL is required when the burn indexer is enabled.");
      }
      const burnFromBlock = env.burnIndexerFromBlock;
      if (burnFromBlock === undefined || burnFromBlock <= 0n) {
        throw new Error(
          "BURN_INDEXER_FROM_BLOCK is required on mainnet and must be > 0: use the token mint block.",
        );
      }
      if (env.burnConfirmations < 60) {
        throw new Error("BURN_CONFIRMATIONS must be >= 60 on mainnet.");
      }
    }
  } else if (process.env.BURN_INDEXER_ENABLED === "true") {
    throw new Error("BURN_TOKEN_ADDRESS is required when BURN_INDEXER_ENABLED=true.");
  }

  if (env.allowManualPrices) {
    throw new Error("ALLOW_MANUAL_PRICES must be false during Phase 1 (USDG-only).");
  }
  const mediaTrial = process.env.TRIAL_FREE_MEDIA_ATTEMPTS;
  if (mediaTrial !== undefined && mediaTrial.trim() !== "" && Number(mediaTrial) !== 0) {
    throw new Error(
      "TRIAL_FREE_MEDIA_ATTEMPTS must be 0 during Phase 1 production (free media is disabled).",
    );
  }

  // Sanity: jangan sampai alamat contoh Epoch/testnet dipakai di mainnet.
  const knownBad = new Set([
    "0x31d02e01406bf31df857fd65865e03d4dd5ab82a", // DepositManager testnet
  ]);
  if (knownBad.has(depositManager.toLowerCase())) {
    throw new Error("DEPOSIT_MANAGER_ADDRESS points to the known testnet deployment.");
  }
}

/** Nilai contoh yang TIDAK boleh dipakai di produksi. */
const DEV_SESSION_SECRET = "dev-insecure-session-secret";

/**
 * Secret yang wajib aman di produksi.
 *
 * Gagal-keras (bukan diam-diam memakai default) supaya salah-konfigurasi deploy
 * tidak membuat server memakai secret publik — yang berarti siapa pun yang tahu
 * `projectId` bisa memalsukan cookie sesi. Di luar produksi nilai contoh tetap
 * dipakai agar dev/smoke test tidak perlu menyetel apa pun.
 */
function assertProdSecret(name: string, value: string | undefined, devFallback: string): string {
  const raw = value?.trim();
  if (!raw) {
    if (isProd()) {
      throw new Error(`Environment variable ${name} is required when NODE_ENV=production.`);
    }
    return devFallback;
  }
  if (isProd() && (raw === devFallback || raw.length < 32)) {
    throw new Error(
      `Environment variable ${name} is not safe for production: at least 32 characters and not the example value.`,
    );
  }
  return raw;
}

export const env = {
  get port(): number {
    return numberEnv("PORT", 3000, { min: 1, max: 65535, integer: true });
  },
  get databaseUrl(): string | undefined {
    return process.env.DATABASE_URL;
  },
  /**
   * Origin kanonis untuk tautan share/OG. Wajib absolut bila diisi; jangan
   * mengandalkan `Host` dari reverse proxy untuk URL yang dilihat crawler.
   */
  get publicBaseUrl(): string | undefined {
    const raw = process.env.PUBLIC_BASE_URL?.trim();
    if (!raw) return undefined;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("PUBLIC_BASE_URL must be an absolute URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("PUBLIC_BASE_URL must use http or https.");
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  },
  /**
   * Folder hasil build frontend yang dibaca backend untuk menyuntikkan meta OG
   * ke shell SPA. Di VPS folder ini di-mount read-only; di lokal default ke
   * `frontend/dist`.
   */
  get frontendDistDir(): string | undefined {
    const raw = process.env.FRONTEND_DIST_DIR?.trim();
    return raw ? raw.replace(/[\\/]+$/, "") : undefined;
  },
  /** Gate output media di halaman share. Default mati sampai moderasi tersedia. */
  get mediaShareEnabled(): boolean {
    const raw = process.env.MEDIA_SHARE_ENABLED?.trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  },
  get sessionSecret(): string {
    return assertProdSecret("SESSION_SECRET", process.env.SESSION_SECRET, DEV_SESSION_SECRET);
  },
  /**
   * Host yang boleh muncul sebagai `domain` pada pesan SIWE.
   *
   * Di produksi wajib eksplisit dan tanpa wildcard (lihat `parseSiweDomains`);
   * di dev/test daftar kosong berarti host backend sendiri.
   */
  get siweDomains(): string[] {
    const configured = parseSiweDomains(
      process.env.SIWE_DOMAIN,
      process.env.FRONTEND_URL,
      isProd(),
    );
    return configured.length > 0 ? configured : [`localhost:${this.port}`];
  },
  get higgsfieldApiUrl(): string {
    return process.env.HIGGSFIELD_API_URL ?? "https://platform.higgsfield.ai";
  },
  // Base URL provider bisa di-override agar bisa diarahkan ke mock server lokal
  // (uji E2E tanpa API key asli) atau gateway/proxy.
  get anthropicApiUrl(): string {
    return process.env.ANTHROPIC_API_URL ?? "https://api.anthropic.com";
  },
  /** Base URL MIMO Token Plan (OpenAI-compat). Diambil dari halaman Token Plan. */
  get mimoApiUrl(): string {
    const raw = process.env.MIMO_API_URL?.trim();
    return raw ? raw.replace(/\/$/, "") : "https://token-plan-cn.xiaomimimo.com/v1";
  },
  /** Model MIMO default (bisa di-override per model_ref di pricing.yaml). */
  get mimoModel(): string {
    return process.env.MIMO_MODEL ?? "mimo-v2.6-flash";
  },
  get openaiApiUrl(): string {
    return process.env.OPENAI_API_URL ?? "https://api.openai.com";
  },
  get perplexityApiUrl(): string {
    return process.env.PERPLEXITY_API_URL ?? "https://api.perplexity.ai";
  },
  // Ketahanan panggilan provider (retry + timeout) berlaku untuk semua adapter.
  get providerRetryAttempts(): number {
    return numberEnv("PROVIDER_RETRY_ATTEMPTS", 3, { min: 1, integer: true });
  },
  get providerTimeoutMs(): number {
    return numberEnv("PROVIDER_TIMEOUT_MS", 120_000, { min: 1000, integer: true });
  },
  /**
   * Batas keras ukuran request chat (total karakter semua pesan). Tanpa batas
   * ini, satu request bisa mengirim konteks raksasa dan biaya provider jauh
   * melebihi estimasi yang ditahan saat reservasi.
   */
  get maxRequestChars(): number {
    return numberEnv("MAX_REQUEST_CHARS", 200_000, { min: 1000, integer: true });
  },
  /** Batas token output per step teks (diteruskan ke provider). */
  get maxOutputTokensPerStep(): number {
    return numberEnv("MAX_OUTPUT_TOKENS_PER_STEP", 4096, { min: 1, max: 200_000, integer: true });
  },
  /**
   * Batas biaya provider per run (USD). Run dihentikan sebelum step berikutnya
   * bila biaya aktual sudah melewati batas; ini pengaman terhadap prompt raksasa
   * atau recipe yang salah konfigurasi, bukan pengganti reservasi.
   */
  get maxProviderCostUsdPerRun(): number {
    return numberEnv("MAX_PROVIDER_COST_USD_PER_RUN", 5, { min: 0.01 });
  },

  // ── Onchain (Fase 2: deposit indexer) ──────────────────────────────────────
  /** RPC Robinhood Chain. Tanpa ini, indexer tidak bisa jalan. */
  get robinhoodRpcUrl(): string | undefined {
    return process.env.ROBINHOOD_RPC_URL;
  },
  /** Chain id (default: Robinhood Chain testnet 46630). */
  get chainId(): number {
    return numberEnv("CHAIN_ID", 46630, { min: 1, integer: true });
  },
  get gattaiTokenAddress(): string | undefined {
    return optionalEnv("GATTAI_TOKEN_ADDRESS");
  },
  /**
   * Token yang dipakai untuk snapshot saldo holder. Default token GATTAI resmi.
   * Terpisah dari `BURN_TOKEN_ADDRESS` agar konfigurasi burn tidak mengubah tier.
   */
  get holderTokenAddress(): string {
    return optionalEnv("HOLDER_TOKEN_ADDRESS") ?? MAINNET_CONTRACTS.token;
  },
  get usdgTokenAddress(): string | undefined {
    return optionalEnv("USDG_TOKEN_ADDRESS");
  },
  get depositManagerAddress(): string | undefined {
    return optionalEnv("DEPOSIT_MANAGER_ADDRESS");
  },
  get treasuryAddress(): string | undefined {
    return optionalEnv("TREASURY_ADDRESS");
  },
  /** Feed Chainlink ETH/USD. Kosong = tidak tersedia (deposit ETH tidak dinegosiasi). */
  get chainlinkEthUsdFeed(): string | undefined {
    return optionalEnv("CHAINLINK_ETH_USD_FEED");
  },
  /** Pool Uniswap V3 GATTAI untuk TWAP. Kosong = belum tersedia (fail-closed). */
  get gattaiTwapPool(): string | undefined {
    return optionalEnv("GATTAI_TWAP_POOL");
  },
  /**
   * Harga manual (USD) untuk ETH/GATTAI. Offchain dan dimatikan secara default;
   * hanya dipakai bila diisi dan (bukan produksi ATAU ALLOW_MANUAL_PRICES=true).
   */
  get ethUsdPriceOverride(): number | undefined {
    return optionalNumber("ETH_USD_PRICE");
  },
  get gattaiUsdPriceOverride(): number | undefined {
    return optionalNumber("GATTAI_USD_PRICE");
  },
  get allowManualPrices(): boolean {
    return process.env.ALLOW_MANUAL_PRICES === "true";
  },
  /** Desimal token USDG (default 6, seperti stablecoin umum). */
  get usdgDecimals(): number {
    return numberEnv("USDG_DECIMALS", 6, { min: 0, max: 36, integer: true });
  },
  /** Jumlah konfirmasi minimal sebelum deposit dikreditkan. */
  get depositConfirmations(): number {
    return numberEnv("DEPOSIT_CONFIRMATIONS", 3, { min: 0, max: 1000, integer: true });
  },
  /** Aset yang boleh ditampilkan/dikreditkan (produksi default USDG-only). */
  get depositEnabledSymbols(): Set<string> {
    return parseDepositSymbols(process.env.DEPOSIT_ENABLED_SYMBOLS, isProd());
  },
  /** Hidupkan reconciler deposit di dalam proses API (default: aktif). */
  get indexerEnabled(): boolean {
    return process.env.INDEXER_ENABLED !== "false";
  },
  /** Blok awal catch-up indexer (kosong = mulai dari head saat ini). */
  get indexerFromBlock(): bigint | undefined {
    const raw = process.env.INDEXER_FROM_BLOCK;
    if (!raw || raw.trim() === "") return undefined;
    return BigInt(raw);
  },
  /** Selang polling indexer (ms). */
  get indexerPollIntervalMs(): number {
    return numberEnv("INDEXER_POLL_INTERVAL_MS", 15_000, { min: 1000, integer: true });
  },
  /** Ukuran batch blok per getLogs (menghindari limit RPC). */
  get indexerBatchBlocks(): number {
    return numberEnv("INDEXER_BATCH_BLOCKS", 2000, { min: 1, integer: true });
  },
  /** Daftar endpoint RPC cadangan (dipisah koma) untuk `fallback`. */
  get robinhoodRpcFallbackUrls(): string[] {
    return (process.env.ROBINHOOD_RPC_URL_FALLBACKS ?? "")
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url !== "");
  },
  /** Timeout per permintaan RPC (ms). */
  get rpcTimeoutMs(): number {
    return numberEnv("RPC_TIMEOUT_MS", 15_000, { min: 1000, integer: true });
  },
  /**
   * Timeout khusus pembacaan saldo holder. Lebih pendek dari RPC indexer agar
   * `/v1/holder/status` tidak menggantung saat RPC lambat.
   */
  get holderRpcTimeoutMs(): number {
    return numberEnv("HOLDER_RPC_TIMEOUT_MS", 3000, { min: 500, max: 30_000, integer: true });
  },
  /**
   * Kedalaman blok untuk snapshot saldo holder. Membaca `latest - N` membuat
   * snapshot tidak langsung berubah saat terjadi reorg pendek.
   */
  get holderSnapshotConfirmations(): number {
    return numberEnv("HOLDER_SNAPSHOT_CONFIRMATIONS", 60, {
      min: 0,
      max: 1000,
      integer: true,
    });
  },
  /** Jumlah percobaan ulang per permintaan RPC. */
  get rpcRetryCount(): number {
    return numberEnv("RPC_RETRY_COUNT", 3, { min: 0, max: 20, integer: true });
  },
  /**
   * Ambang minimum nilai deposit (USD) agar dikreditkan (anti-spam dust).
   * `0` menonaktifkan ambang. Default $0.01.
   */
  get depositMinUsd(): number {
    return numberEnv("DEPOSIT_MIN_USD", 0.01, { min: 0 });
  },
  /** Kedalaman blok yang diperiksa penjaga reorg (deposit yang lebih lama dianggap final). */
  get indexerReorgLookback(): number {
    return numberEnv("INDEXER_REORG_LOOKBACK", 64, { min: 1, integer: true });
  },
  /** Umur run non-terminal sebelum dianggap yatim dan di-reap (ms). Default 30 menit. */
  get runStaleAfterMs(): number {
    return numberEnv("RUN_STALE_AFTER_MS", 30 * 60_000, { min: 60_000, integer: true });
  },
  /** Umur konfirmasi media yang ditinggalkan sebelum kedaluwarsa (ms). Default 24 jam. */
  get runConfirmExpiryMs(): number {
    return numberEnv("RUN_CONFIRM_EXPIRY_MS", 24 * 3600_000, { min: 60_000, integer: true });
  },
  /**
   * Selang reaper run yatim (ms). Default 5 menit.
   *
   * Tanpa timer berkala, run yang macet hanya dibereskan saat startup — server
   * yang hidup lama menahan reservasi credits dan jatah media sampai restart.
   */
  get reapIntervalMs(): number {
    return numberEnv("REAP_INTERVAL_MS", 5 * 60_000, { min: 60_000, integer: true });
  },
  /** Jendela rate limit (ms). */
  get rateLimitWindowMs(): number {
    return numberEnv("RATE_LIMIT_WINDOW_MS", 60_000, { min: 1000, integer: true });
  },
  /** Maksimum request per jendela per IP (anti-abuse global). */
  get rateLimitIpPerMin(): number {
    return numberEnv("RATE_LIMIT_IP_PER_MIN", 600, { min: 1, integer: true });
  },
  /**
   * Jumlah hop proxy terpercaya di depan API. Dipakai menafsirkan
   * `X-Forwarded-For`: entri diambil `N` posisi dari kanan (bukan paling kiri),
   * karena nilai paling kiri bisa dikirim klien dan memutar batas rate limit.
   * Railway = 1 hop. Rentang aman 1–5.
   */
  get trustedProxyHops(): number {
    return numberEnv("TRUSTED_PROXY_HOPS", 1, { min: 1, max: 5, integer: true });
  },
  /** Maksimum pembuatan run per jendela per project (penjaga belanja provider). */
  get rateLimitRunsPerMin(): number {
    return numberEnv("RATE_LIMIT_RUNS_PER_MIN", 120, { min: 1, integer: true });
  },

  // ── Burn (Fase 3: epoch buyback & burn) ────────────────────────────────────
  /** Durasi satu epoch burn (jam). Default 168 = mingguan. */
  get burnEpochHours(): number {
    return numberEnv("BURN_EPOCH_HOURS", 168, { min: 1, integer: true });
  },
  /** Awal epoch pertama (ISO 8601). Window di-tile dari sini. */
  get burnGenesis(): Date {
    return parseDate(process.env.BURN_GENESIS, new Date("2026-01-01T00:00:00.000Z"));
  },
  /** Selang polling worker burn (ms). */
  get burnPollIntervalMs(): number {
    return numberEnv("BURN_POLL_INTERVAL_MS", 3_600_000, { min: 1000, integer: true });
  },
  /** Izinkan eksekusi burn onchain otomatis (treasury EOA). Default: dry-run. */
  get burnExecute(): boolean {
    return process.env.BURN_EXECUTE === "true";
  },
  /** Kunci privat treasury untuk eksekusi otomatis (hanya bila BURN_EXECUTE=true). */
  get burnTreasuryPrivateKey(): string | undefined {
    return optionalEnv("BURN_TREASURY_PRIVATE_KEY");
  },

  // ── Burn indexer (Fase 1: index transfer token ke dead address) ────────────
  /**
   * Token resmi $GATTAI yang diindeks. Dipisahkan dari `GATTAI_TOKEN_ADDRESS`
   * (yang tetap kosong selama Phase 1 USDG-only) supaya deposit dan burn bisa
   * dikonfigurasi independen.
   */
  get burnTokenAddress(): string | undefined {
    return optionalEnv("BURN_TOKEN_ADDRESS");
  },
  get burnTokenSymbol(): string {
    return optionalEnv("BURN_TOKEN_SYMBOL") ?? "GATTAI";
  },
  get burnTokenDecimals(): number {
    return numberEnv("BURN_TOKEN_DECIMALS", 18, { min: 0, max: 36, integer: true });
  },
  /** Total supply base-unit; default 1 miliar token (sesuai token launch). */
  get burnTokenTotalSupply(): bigint {
    return (
      optionalBigInt("BURN_TOKEN_TOTAL_SUPPLY") ??
      1_000_000_000n * 10n ** BigInt(this.burnTokenDecimals)
    );
  },
  /** Hidupkan indexer burn bila token dikonfigurasi (default: aktif). */
  get burnIndexerEnabled(): boolean {
    return process.env.BURN_INDEXER_ENABLED !== "false" && Boolean(this.burnTokenAddress);
  },
  /** Blok mint/launch; wajib untuk backfill mainnet. */
  get burnIndexerFromBlock(): bigint | undefined {
    return optionalBigInt("BURN_INDEXER_FROM_BLOCK");
  },
  get burnConfirmations(): number {
    return numberEnv("BURN_CONFIRMATIONS", 60, { min: 0, max: 1000, integer: true });
  },
  get burnIndexerPollIntervalMs(): number {
    return numberEnv("BURN_INDEXER_POLL_INTERVAL_MS", this.indexerPollIntervalMs, {
      min: 1000,
      integer: true,
    });
  },
  get burnIndexerBatchBlocks(): number {
    return numberEnv("BURN_INDEXER_BATCH_BLOCKS", this.indexerBatchBlocks, {
      min: 1,
      integer: true,
    });
  },
  /** Kedalaman pemeriksaan reorg untuk burn yang sudah tercatat. */
  get burnIndexerReorgLookback(): number {
    return numberEnv("BURN_INDEXER_REORG_LOOKBACK", 128, { min: 1, integer: true });
  },
  /** Wallet tim/treasury yang transfernya diklasifikasikan `team`. */
  get teamBurnWallets(): string[] {
    return parseAddressList("TEAM_BURN_WALLETS", process.env.TEAM_BURN_WALLETS, []);
  },
  /**
   * Wallet yang tidak boleh muncul di `/leaderboard` (kontrak internal, akun
   * operasional, dsb). Tim/treasury sudah otomatis dikecualikan; daftar ini
   * untuk alamat tambahan yang tidak ingin diumumkan lewat peringkat.
   */
  get leaderboardExcludedWallets(): string[] {
    return parseAddressList(
      "LEADERBOARD_EXCLUDED_WALLETS",
      process.env.LEADERBOARD_EXCLUDED_WALLETS,
      [],
    );
  },
  /** Alamat dead/burn tujuan. Default `0x…dEaD`. */
  get burnDeadAddresses(): string[] {
    return parseAddressList("BURN_DEAD_ADDRESSES", process.env.BURN_DEAD_ADDRESSES, [
      "0x000000000000000000000000000000000000dEaD",
    ]);
  },
};

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function optionalNumber(name: string): number | undefined {
  const raw = optionalEnv(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number when set.`);
  }
  return value;
}

/** Bilangan bulat non-negatif (mis. base-unit token) dari env. */
function optionalBigInt(name: string): bigint | undefined {
  const raw = optionalEnv(name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Environment variable ${name} must be a non-negative integer when set.`);
  }
  return BigInt(raw);
}

/** Daftar alamat 0x… (dipisah koma); setiap entri divalidasi. */
function parseAddressList(name: string, raw: string | undefined, fallback: string[]): string[] {
  const entries = (raw && raw.trim() !== "" ? raw.split(",") : fallback)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    if (!ADDRESS_RE.test(entry)) {
      throw new Error(`${name} contains an invalid 0x-prefixed 20-byte address: ${entry}`);
    }
  }
  return [...new Set(entries.map((entry) => entry.toLowerCase()))];
}

function parseDate(raw: string | undefined, fallback: Date): Date {
  if (!raw || raw.trim() === "") return fallback;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/**
 * Ubah satu entri konfigurasi menjadi host (`hostname[:port]`).
 *
 * Menerima host polos (`www.gattai.tech`, `localhost:5173`) maupun origin penuh
 * (`https://www.gattai.tech`) — `window.location.host` adalah bentuk pertama,
 * tapi salah-tulis yang umum sebaiknya tidak membuat login mustahil. `*` bukan
 * host: ia ditangani terpisah oleh `parseSiweDomains`.
 */
function hostFromEntry(entry: string): string | undefined {
  const value = entry.trim();
  if (!value || value === "*") return undefined;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.host.toLowerCase();
  } catch {
    return undefined;
  }
}

interface ParsedHostList {
  hosts: string[];
  wildcard: boolean;
}

function parseHostList(raw: string | undefined): ParsedHostList {
  const hosts: string[] = [];
  let wildcard = false;
  for (const entry of (raw ?? "").split(",")) {
    if (entry.trim() === "*") {
      wildcard = true;
      continue;
    }
    const host = hostFromEntry(entry);
    if (host) hosts.push(host);
  }
  return { hosts: [...new Set(hosts)], wildcard };
}

/**
 * Daftar host yang boleh menandatangani pesan SIWE (`domain` pada EIP-4361).
 *
 * Sumbernya `SIWE_DOMAIN` (dipisah koma) bila diisi; kalau tidak, diturunkan
 * dari `FRONTEND_URL`. Dalam praktik keduanya memang sama — host tempat user
 * membuka frontend — jadi menurunkannya mencegah dua variabel berbeda pendapat
 * (gejala: login gagal hanya di salah satu host).
 *
 * Di produksi daftar **tidak boleh kosong** dan **tidak boleh** memuat `*`:
 * wildcard berarti domain mana pun (termasuk milik penyerang) boleh memakai
 * nonce kita — persis lubang yang SIWE dirancang menutup. Lebih baik gagal saat
 * boot daripada diam-diam terbuka.
 */
export function parseSiweDomains(
  rawSiwe: string | undefined,
  rawFrontend: string | undefined,
  prod: boolean,
): string[] {
  const explicit = parseHostList(rawSiwe);
  const fromFrontend = parseHostList(rawFrontend);
  // FRONTEND_URL hanya dipakai bila SIWE_DOMAIN tidak menyebut apa pun (host
  // maupun wildcard) — wildcard eksplisit harus tetap terdeteksi, bukan diabaikan.
  const source = explicit.hosts.length > 0 || explicit.wildcard ? explicit : fromFrontend;

  if (prod) {
    if (source.wildcard) {
      throw new Error(
        'Environment variable SIWE_DOMAIN must not contain "*" when NODE_ENV=production.',
      );
    }
    if (source.hosts.length === 0) {
      throw new Error(
        "Environment variable SIWE_DOMAIN (or FRONTEND_URL) must list at least one host when NODE_ENV=production.",
      );
    }
  }

  return source.hosts;
}

export type ProviderKeyName = "anthropic" | "openai" | "perplexity" | "higgsfield" | "mimo";

const KEY_ENV: Record<ProviderKeyName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  higgsfield: "HIGGSFIELD_API_KEY",
  mimo: "MIMO_API_KEY",
};

export function getProviderApiKey(provider: ProviderKeyName): string {
  return required(KEY_ENV[provider], process.env[KEY_ENV[provider]]);
}

/**
 * Nama env provider yang belum diisi.
 *
 * Dipakai peringatan startup agar operator tahu sebelum user terkena error.
 * Nama variabel hanya untuk log server — jangan pernah dikirim ke klien.
 */
export function missingProviderKeys(): string[] {
  return (Object.keys(KEY_ENV) as ProviderKeyName[])
    .map((provider) => KEY_ENV[provider])
    .filter((name) => !process.env[name] || process.env[name]!.trim() === "");
}

/**
 * Apakah provider ini punya kredensial.
 *
 * Dipakai orkestrasi untuk menandai formasi yang belum bisa dijalankan (mis.
 * formasi media tanpa key Higgsfield) sehingga UI bisa menampilkan "coming soon"
 * alih-alih membiarkan user menabrak error setelah menekan tombol. Dibaca lazy
 * saat dipanggil supaya perubahan env (menambah/mencabut key) langsung terasa
 * tanpa restart, dan supaya test bisa menambalnya. Nama env tidak pernah keluar
 * dari sini — hanya boolean.
 */
export function isProviderConfigured(provider: string): boolean {
  const envName = KEY_ENV[provider as ProviderKeyName];
  if (!envName) return false;
  return Boolean(process.env[envName]?.trim());
}

export function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}
