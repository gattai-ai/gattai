/**
 * Tipe respons API yang dipakai frontend. Bentuknya mengikuti serializer backend
 * (lihat backend/src/serialize.ts dan docs/05-api-reference.md).
 */

export interface SessionResponse {
  project: { id: string; address: string };
}

/** Kuota prompt gratis (trial) milik wallet. */
export interface TrialQuota {
  limit: number;
  /** Kuota teks yang terpakai (formasi media punya hitungan sendiri di `media_used`). */
  text_used: number;
  remaining: number;
  attempts_limit: number;
  attempts_used: number;
  /** Jatah percobaan untuk formasi media (opsional: API lama tidak mengirimnya). */
  media_limit?: number;
  media_used?: number;
}

export interface ProjectInfo {
  project_id: string;
  name: string;
  owner_wallet: string | null;
  onchain_id: string | null;
  status: string;
  created_at: string;
  trial?: TrialQuota;
}

export interface Lot {
  id: string;
  source: "ETH" | "USDG" | "GATTAI" | "PROMO";
  deposit_tx: string | null;
  amount_micro: number;
  remaining_micro: number;
  amount_credits: number;
  remaining_credits: number;
  created_at: string;
}

export interface BalanceResponse {
  balance_micro: number;
  balance_credits: number;
  lots: Lot[];
}

export type LedgerType = "DEPOSIT" | "RESERVE" | "SETTLE" | "RELEASE";

export interface LedgerEntry {
  id: string;
  run_id: string | null;
  lot_id: string | null;
  type: LedgerType;
  amount_micro: number;
  amount_credits: number;
  balance_after_micro: number;
  balance_after_credits: number;
  created_at: string;
}

export interface UsageResponse {
  entries: LedgerEntry[];
}

export interface ApiKey {
  id: string;
  prefix: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface ApiKeyListResponse {
  keys: ApiKey[];
}

export interface CreatedApiKey extends ApiKey {
  secret: string;
}

export interface Estimate {
  credits: number;
  usd: number;
  reserve_micro: number;
  provider_cost_usd: number;
  markup: number;
  requires_confirmation: boolean;
}

export interface RecipeStep {
  id: string;
  /** Nama provider publik (GPT/Claude/…). Provider internal tidak pernah dikirim API. */
  provider: string;
  role: string;
  /** Nama role publik (mis. `render · video`); fallback ke `role`. */
  role_label?: string;
  async: boolean;
  stream: boolean;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  mode: string;
  /**
   * `false` = provider yang dibutuhkan belum dikonfigurasi di server → formasi
   * "coming soon": tidak bisa dipilih dan `POST /v1/runs` menolaknya (503).
   * Opsional supaya response lama (sebelum field ini ada) tidak ikut ditandai.
   */
  available?: boolean;
  markup: number;
  pricing: Estimate & { markup?: number };
  steps: RecipeStep[];
}

export interface RecipesResponse {
  recipes: Recipe[];
}

/** Status ketersediaan satu formasi dari `/v1/public/formations` (tanpa auth). */
export interface FormationAvailability {
  id: string;
  name: string;
  available: boolean;
}

export interface FormationsResponse {
  formations: FormationAvailability[];
}

export type RunStatus =
  | "CREATED"
  | "RESERVED"
  | "RUNNING"
  | "AWAITING_CONFIRMATION"
  | "INSUFFICIENT_BALANCE"
  | "SETTLED"
  | "RELEASED";

export interface RunCreateResponse {
  run_id: string;
  status: RunStatus;
  estimate: Estimate;
  is_trial: boolean;
  /** Percakapan tempat run ini dicatat. Dibuat server bila klien tidak mengirim id; `null` pada replay run lama. */
  conversation_id: string | null;
}

export interface RunStepInfo {
  id: string;
  /** Nama provider publik (GPT/Claude/…). */
  provider: string;
  role: string;
  /** Nama role publik; fallback ke `role`. */
  role_label?: string;
  status: string;
  usage: { input_tokens: number | null; output_tokens: number | null; units: number | null };
  provider_cost_usd: number;
  latency_ms: number | null;
  error: string | null;
}

export interface RunInfo {
  run_id: string;
  recipe: string;
  recipe_version: number;
  status: RunStatus;
  mode: string;
  is_trial: boolean;
  /** Prompt user yang tersimpan, dipakai untuk menggambar ulang transkrip percakapan. */
  input: string;
  output: unknown;
  cost: {
    reserved_micro: number;
    charged_micro: number;
    charged_credits: number;
    charged_usd: number;
    provider_cost_usd: number;
  };
  error: string | null;
  created_at: string;
  finished_at: string | null;
  steps?: RunStepInfo[];
}

/** SSE event dari GET /v1/runs/{id}/events. */
export type RunEvent =
  | { type: "status"; status: string }
  | { type: "step_pending"; stepId: string }
  | { type: "step_complete"; stepId: string; providerCostUsd: number }
  | { type: "step_failed"; stepId: string; error: string }
  | { type: "delta"; text: string }
  | { type: "ping" }
  | { type: "done"; status: string };

/** Satu baris daftar riwayat percakapan (`GET /v1/conversations`). */
export interface ShareInfo {
  slug: string;
  show_prompt: boolean;
  created_at: string;
}

/** Response POST /v1/runs/:id/share (hanya untuk pemilik). */
export interface ShareResponse extends ShareInfo {
  url: string;
}

export interface ConversationSummary {
  id: string;
  /** Nullable di DB; UI menampilkan fallback "New chat". */
  title: string | null;
  created_at: string;
  last_run_at: string | null;
  run_count: number;
  /** Run SETTLED terbaru; sumber tombol Share di History. */
  latest_settled_run_id?: string | null;
  /** Share aktif untuk run SETTLED terbaru, bila ada. */
  share?: ShareInfo | null;
}

/** GET /v1/public/runs/:slug — kontrak publik yang sempit. */
export interface PublicRunResponse {
  slug: string;
  formation: { id: string; name: string; mode: string };
  /** Null bila pemilik memilih menyembunyikan prompt. */
  prompt: string | null;
  output: {
    type: string;
    content: string | null;
    media: { type: string; url: string } | null;
  };
  steps: Array<{
    role: string;
    role_label: string;
    provider: string;
    status: string;
    summary: string | null;
    duration_ms: number | null;
  }>;
  cost: { credits: string; usd: string };
  created_at: string;
  finished_at: string | null;
}

export type LeaderboardWeekLabel = "current" | "previous";

export interface LeaderboardWeek {
  start: string;
  /** Senin berikutnya 00:00 UTC (eksklusif). */
  end: string;
  label: LeaderboardWeekLabel;
}

export interface LeaderboardEntry {
  rank: number;
  /** Alias publik `Project <4 hex>`, bukan wallet. */
  display_name: string;
  runs: number;
  is_me?: boolean;
}

export interface LeaderboardMe {
  rank: number | null;
  runs: number;
  opted_out: boolean;
  display_name: string;
}

/** GET /v1/public/leaderboard — `me` selalu null karena response di-cache. */
export interface LeaderboardResponse {
  week: LeaderboardWeek;
  entries: LeaderboardEntry[];
  me: LeaderboardMe | null;
  updated_at: string;
}

/** GET /v1/leaderboard/me — rank user login, termasuk di luar top 20. */
export interface LeaderboardMeResponse {
  week: LeaderboardWeek;
  me: LeaderboardMe;
}

export interface LeaderboardOptOutResponse {
  opted_out: boolean;
}

export interface ConversationsResponse {
  conversations: ConversationSummary[];
  /** Masih ada percakapan lebih lama di luar halaman ini. */
  has_more: boolean;
  /** Kursor halaman berikutnya (`<ISO>|<id>`), atau null bila sudah habis. */
  next_cursor: string | null;
}

/** Transkrip satu percakapan; turn memakai bentuk yang sama dengan `RunInfo`. */
export interface ConversationDetailResponse {
  conversation: { id: string; title: string | null; created_at: string };
  turns: RunInfo[];
  /** Masih ada turn lebih lama di luar halaman ini. */
  has_more: boolean;
  /** Kursor `before` untuk halaman berikutnya; `null` bila sudah habis. */
  next_cursor: string | null;
}

export interface DepositConfig {
  chain_id: number;
  deposit_manager: string | null;
  treasury: string | null;
  gattai_token: string | null;
  usdg_token: string | null;
  tokens: { symbol: string; address: string; decimals: number; price_usd?: number | null }[];
  discount_ratio: number;
  cap_usd: number;
  twap_window_minutes: number;
  confirmations: number;
}

export type DepositConfirmStatus =
  | "credited"
  | "duplicate"
  | "pending"
  | "over_cap"
  | "dust"
  | "unpriced"
  | "unknown_token";

export interface DepositConfirmResponse {
  status: DepositConfirmStatus;
  tx_hash: string;
  credits_added?: number;
  balance_credits?: number;
  usd_value?: string;
  reason?: string;
}

export interface BurnEpoch {
  id: string;
  period_start: string;
  period_end: string;
  budget_usd: string;
  tokens_burned: string;
  tx_hashes: string[];
  status: "pending" | "executed" | "failed";
  created_at: string;
}

export type BurnKind = "team" | "epoch" | "community";

/** Satu transfer token ke dead address, hasil indexer burn. */
export interface TokenBurn {
  id: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_timestamp: string | null;
  from: string;
  to: string;
  /** Jumlah base-unit token (integer string). */
  amount_raw: string;
  /** Jumlah desimal untuk tampilan/kompatibilitas. */
  amount: string;
  decimals: number;
  kind: BurnKind;
  epoch_id: string | null;
  created_at: string;
}

export interface BurnsResponse {
  token: {
    address: string | null;
    symbol: string;
    decimals: number;
    total_supply_raw: string;
    total_supply: string;
  };
  /** Total desimal (kompatibilitas); sumber utama frontend: `_raw`. */
  total_tokens_burned: string;
  total_tokens_burned_raw: string;
  team_tokens_burned: string;
  team_tokens_burned_raw: string;
  epoch_tokens_burned: string;
  epoch_tokens_burned_raw: string;
  community_tokens_burned: string;
  community_tokens_burned_raw: string;
  /** Persentase supply dengan 8 desimal, tanpa tanda `%`. */
  burned_percent: string;
  burn_counts: Record<BurnKind, number>;
  burns: TokenBurn[];
  epochs: BurnEpoch[];
}

export interface FormationUsageStat {
  recipe: string;
  name?: string;
  count: number;
}

export interface DailyUsageStat {
  date: string;
  count: number;
}

export interface UsageStats {
  total_runs: number;
  runs_24h: number;
  runs_7d: number;
  by_formation: FormationUsageStat[];
  daily: DailyUsageStat[];
  updated_at: string;
}

export interface DailyRevenueStat {
  date: string;
  usd: string;
}

export interface RevenueStats {
  deposits_usdg: string;
  settled_credits: string;
  settled_usd: string;
  deposits_daily: DailyRevenueStat[];
  updated_at: string;
}

export interface DailyBurnStat {
  date: string;
  tokens: string;
}

export interface BurnsStatsSection {
  total_tokens_burned: string;
  total_tokens_burned_raw: string;
  team_tokens_burned: string;
  team_tokens_burned_raw: string;
  epoch_tokens_burned: string;
  epoch_tokens_burned_raw: string;
  community_tokens_burned: string;
  community_tokens_burned_raw: string;
  decimals: number;
  total_supply: string;
  daily: DailyBurnStat[];
  updated_at: string;
}

export interface ContractAddressInfo {
  address: string;
  explorer_url: string;
}

export interface DepositManagerInfo extends ContractAddressInfo {
  paused: boolean | null;
}

export interface TokenContractInfo extends ContractAddressInfo {
  symbol: string;
  decimals: number;
}

export interface ContractsStatsSection {
  chain_id: number;
  deposit_manager: DepositManagerInfo;
  treasury: ContractAddressInfo;
  token: TokenContractInfo;
  updated_at: string;
}

export interface HolderTierUsageStat {
  tier: string;
  name: string;
  count: number;
}

export interface DailyHolderStat {
  date: string;
  count: number;
  subsidized_usd: string;
}

export interface HolderStatsSection {
  total_runs: number;
  runs_24h: number;
  runs_7d: number;
  subsidized_cost_usd: string;
  allocated_pool_usd: string;
  by_tier: HolderTierUsageStat[];
  daily: DailyHolderStat[];
  updated_at: string;
}

export interface StatsResponse {
  usage: UsageStats;
  revenue: RevenueStats;
  burns: BurnsStatsSection;
  contracts: ContractsStatsSection;
  holders: HolderStatsSection;
}

// ── Holder Tiers ─────────────────────────────────────────────────────────────

export interface HolderTierItem {
  id: string;
  name: string;
  min_tokens: string;
  free_runs_per_day: number;
  free_media_per_day: number;
  badge: "bronze" | "silver" | "gold";
  perks: string[];
}

export interface HolderPublicTiersResponse {
  tiers: HolderTierItem[];
  rules: {
    snapshot_interval_hours: number;
    consecutive_snapshots_required: number;
    reset_time_utc: string;
    daily_budget_usd: string;
    enabled: boolean;
  };
}

export interface HolderSnapshotData {
  balance: string;
  balance_raw: string;
  block_number: number;
  taken_at: string;
  explorer_url: string;
}

export interface HolderQuotaData {
  limit: number;
  used: number;
  remaining: number;
  media_limit: number;
  media_used: number;
  media_remaining: number;
  resets_at: string;
}

export interface NextTierProgressData {
  id: string;
  name: string;
  min_tokens: string;
  tokens_needed: string;
  progress_pct: number;
}

export interface PendingTierData {
  target_tier: string | null;
  message: string | null;
  next_snapshot_at: string | null;
}

export interface HolderTodayRunData {
  id: string;
  recipe_id: string;
  formation_name: string;
  created_at: string;
  status: string;
  share_slug: string | null;
}

export interface HolderBudgetData {
  exhausted: boolean;
  daily_budget_usd: string;
  spent_today_usd: string;
  resets_at: string;
}

export interface HolderStatusResponse {
  tier: HolderTierItem | null;
  snapshot: HolderSnapshotData | null;
  free_runs: HolderQuotaData;
  next_tier: NextTierProgressData | null;
  pending: PendingTierData;
  today_runs: HolderTodayRunData[];
  budget: HolderBudgetData;
  kill_switch: boolean;
}


