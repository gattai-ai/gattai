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
export interface ConversationSummary {
  id: string;
  /** Nullable di DB; UI menampilkan fallback "New chat". */
  title: string | null;
  created_at: string;
  last_run_at: string | null;
  run_count: number;
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

export interface BurnsResponse {
  total_tokens_burned: string;
  epochs: BurnEpoch[];
}
