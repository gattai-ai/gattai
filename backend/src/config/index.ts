import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Konfigurasi GATTAI dimuat dari `backend/config/*.yaml`.
 *
 * Semua nilai bisnis (harga, markup, diskon, parameter burn) ada di sini,
 * bukan di kode. Harga provider sering berubah, jadi bisa di-reload tanpa
 * deploy. Recipe hanya menunjuk `model_ref`; model asli dipetakan di
 * pricing.yaml sehingga bisa diganti tanpa menyentuh kode.
 */

const PROVIDERS = ["anthropic", "openai", "perplexity", "higgsfield", "mimo"] as const;

// ── Model ────────────────────────────────────────────────────────────────────

const textModelSchema = z.object({
  provider: z.enum(["anthropic", "openai", "perplexity", "mimo"]),
  model: z.string().min(1),
  kind: z.literal("text"),
  input_per_mtok_usd: z.number().nonnegative(),
  output_per_mtok_usd: z.number().nonnegative(),
});

const unitModelSchema = z.object({
  provider: z.literal("higgsfield"),
  model: z.string().min(1),
  kind: z.enum(["image", "video", "audio"]),
  unit_usd: z.number().nonnegative(),
});

const modelSchema = z.discriminatedUnion("kind", [textModelSchema, unitModelSchema]);

const modelsSchema = z.record(z.string(), modelSchema);

const pricingFileSchema = z.object({ models: modelsSchema });

// ── Recipe ───────────────────────────────────────────────────────────────────

const stepSchema = z.object({
  id: z.string().min(1),
  provider: z.enum(PROVIDERS),
  model_ref: z.string().min(1),
  role: z.string().min(1),
  /** Nama provider yang tampil ke pengguna; routing tetap memakai `provider`. */
  label: z.string().min(1),
  /** Nama role yang tampil ke pengguna; orkestrasi tetap memakai `role`. */
  role_label: z.string().min(1),
  /**
   * Label role untuk halaman publik `/run/:slug`. Dipisah dari `role_label`
   * supaya istilah internal (mis. `write_report`) bisa tetap dipakai di app
   * tanpa ikut bocor ke halaman share. Opsional: fallback ke `role_label`.
   */
  public_role: z.string().min(1).optional(),
  input_from: z.string().optional(),
  output_schema: z.string().optional(),
  async: z.boolean().optional(),
  stream: z.boolean().optional(),
});

const recipePricingSchema = z.object({
  markup: z.number().nonnegative().optional(),
  requires_confirmation: z.boolean(),
  estimated_input_tokens: z.number().nonnegative().optional(),
  estimated_output_tokens: z.number().nonnegative().optional(),
  estimated_units: z.number().nonnegative().optional(),
});

const recipeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  mode: z.enum(["streaming", "async", "mixed"]),
  steps: z.array(stepSchema).min(1),
  pricing: recipePricingSchema,
});

const recipesFileSchema = z.object({ recipes: z.array(recipeSchema).min(1) });

// ── Holder Tiers ─────────────────────────────────────────────────────────────

const holderTierSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  min_tokens: z.string().min(1),
  free_runs_per_day: z.number().int().nonnegative(),
  free_media_per_day: z.number().int().nonnegative().default(0),
  badge: z.enum(["bronze", "silver", "gold"]),
  perks: z.array(z.string()),
});

// ── Params ───────────────────────────────────────────────────────────────────

const paramsSchema = z.object({
  pricing: z.object({ default_markup: z.number().nonnegative() }),
  reserve: z.object({
    buffer_ratio: z.number().nonnegative(),
    min_micro: z.number().int().nonnegative(),
  }),
  gattai: z.object({ discount_ratio: z.number().min(0).max(1) }),
  burn: z.object({
    share_stable: z.number().min(0).max(1),
    share_token: z.number().min(0).max(1),
  }),
  deposits: z.object({
    cap_usd: z.number().nonnegative(),
    twap_window_minutes: z.number().int().positive(),
  }),
  context: z
    .object({
      // Ambang total karakter riwayat sebelum diringkas (menekan biaya token).
      summary_threshold_chars: z.number().int().positive(),
      // Jumlah pesan terakhir yang dikirim verbatim sebagai konteks `execute`;
      // sisanya diwakili `conversations.summary`.
      history_window_messages: z.number().int().positive(),
    })
    .default({ summary_threshold_chars: 12_000, history_window_messages: 10 }),
  trial: z
    .object({
      // Kuota run gratis per wallet (hanya run yang menghasilkan output).
      free_runs: z.number().int().positive(),
      // Batas total percobaan termasuk yang gagal & di-refund.
      max_attempts: z.number().int().positive(),
      // Jatah gratis untuk formasi media; dihitung dari percobaan (bukan `used`)
      // supaya refund run gagal tidak memulihkannya. 0 = media selalu berbayar.
      free_media_attempts: z.number().int().nonnegative(),
    })
    .default({ free_runs: 10, max_attempts: 30, free_media_attempts: 2 }),
  holder: z
    .object({
      // Kill switch global untuk run tier holder.
      enabled: z.boolean().default(true),
      // Batas anggaran platform harian (USD) untuk subsidi run holder.
      daily_budget_usd: z.number().nonnegative().default(50),
      // Interval snapshot saldo onchain (jam).
      snapshot_interval_hours: z.number().int().positive().default(24),
      // Jumlah snapshot berurutan yang harus memenuhi threshold agar tier aktif.
      consecutive_snapshots_required: z.number().int().positive().default(2),
      // Definisi tingkatan tier holder.
      tiers: z.array(holderTierSchema).min(1),
    })
    .default({
      enabled: true,
      daily_budget_usd: 50,
      snapshot_interval_hours: 24,
      consecutive_snapshots_required: 2,
      tiers: [
        {
          id: "pilot",
          name: "Pilot",
          min_tokens: "10000",
          free_runs_per_day: 5,
          free_media_per_day: 0,
          badge: "bronze",
          perks: [
            "5 free text runs every day",
            "Access to core AI formations",
            "Standard processing priority",
          ],
        },
        {
          id: "commander",
          name: "Commander",
          min_tokens: "50000",
          free_runs_per_day: 15,
          free_media_per_day: 1,
          badge: "silver",
          perks: [
            "15 free text runs every day",
            "1 free media generation every day",
            "High processing priority",
          ],
        },
        {
          id: "admiral",
          name: "Fleet Admiral",
          min_tokens: "250000",
          free_runs_per_day: 40,
          free_media_per_day: 5,
          badge: "gold",
          perks: [
            "40 free text runs every day",
            "5 free media generations every day",
            "VIP processing priority",
            "Early access to upcoming formations",
          ],
        },
      ],
    }),
});

// ── Tipe hasil ───────────────────────────────────────────────────────────────

export type TextModel = z.infer<typeof textModelSchema>;
export type UnitModel = z.infer<typeof unitModelSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export type RecipeStep = z.infer<typeof stepSchema>;
export type RecipeConfig = z.infer<typeof recipeSchema>;
export type RecipePricing = z.infer<typeof recipePricingSchema>;
export type HolderTierConfig = z.infer<typeof holderTierSchema>;
export type Params = z.infer<typeof paramsSchema>;

export interface AppConfig {
  recipes: RecipeConfig[];
  models: Record<string, ModelConfig>;
  params: Params;
}

export type ProviderName = (typeof PROVIDERS)[number];

// ── Loader ───────────────────────────────────────────────────────────────────

const CONFIG_DIR = fileURLToPath(new URL("../../config/", import.meta.url));

function readYaml(file: string): unknown {
  const raw = readFileSync(join(CONFIG_DIR, file), "utf8");
  return parseYaml(raw);
}

function crossValidate(config: AppConfig): void {
  const seen = new Set<string>();
  for (const recipe of config.recipes) {
    if (seen.has(recipe.id)) {
      throw new Error(`Invalid config: duplicate recipe id "${recipe.id}"`);
    }
    seen.add(recipe.id);

    for (const step of recipe.steps) {
      const model = config.models[step.model_ref];
      if (!model) {
        throw new Error(
          `Invalid config: recipe "${recipe.id}" step "${step.id}" points to a model_ref "${step.model_ref}" that does not exist`,
        );
      }
      if (model.provider !== step.provider) {
        throw new Error(
          `Invalid config: recipe "${recipe.id}" step "${step.id}" provider "${step.provider}" does not match model "${step.model_ref}" (${model.provider})`,
        );
      }
    }
  }

  // Anggaran gratis hanya berguna kalau plafon percobaan cukup besar untuk
  // menjangkaunya. Kalau `max_attempts` lebih kecil, pagar platform menutup
  // pintu lebih dulu dan pesan 402-nya menyesatkan (kuota masih tersisa tapi
  // ditolak). Gagalkan saat load, bukan saat user menabraknya.
  const trial = config.params.trial;
  const neededAttempts = trial.free_runs + trial.free_media_attempts;
  if (neededAttempts > trial.max_attempts) {
    throw new Error(
      `Invalid config: params.trial.max_attempts (${trial.max_attempts}) must be >= free_runs + free_media_attempts (${neededAttempts})`,
    );
  }
}

/**
 * Baca override integer dari env untuk parameter trial.
 *
 * `params.yaml` adalah default yang aman untuk produksi. Env override dipakai
 * untuk menyesuaikan kuota per environment tanpa mengubah file yang di-commit.
 * Nilai yang tidak valid tetap ditolak oleh `paramsSchema.parse` di bawah.
 */
function trialEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return Number(raw);
}

export function loadConfig(): AppConfig {
  const recipesFile = recipesFileSchema.parse(readYaml("recipes.yaml"));
  const models = pricingFileSchema.parse(readYaml("pricing.yaml")).models;
  const rawParams = paramsSchema.parse(readYaml("params.yaml"));

  const enabledEnv = process.env.HOLDER_RUNS_ENABLED;
  const holderEnabled =
    enabledEnv !== undefined
      ? enabledEnv !== "false" && enabledEnv !== "0"
      : rawParams.holder.enabled;

  // Override per environment. Jangan mengubah `params.yaml` hanya untuk
  // menaikkan kuota test; biarkan default produksi tetap konservatif.
  const params = paramsSchema.parse({
    ...rawParams,
    trial: {
      free_runs: trialEnv("TRIAL_FREE_RUNS", rawParams.trial.free_runs),
      max_attempts: trialEnv("TRIAL_MAX_ATTEMPTS", rawParams.trial.max_attempts),
      free_media_attempts: trialEnv(
        "TRIAL_FREE_MEDIA_ATTEMPTS",
        rawParams.trial.free_media_attempts,
      ),
    },
    holder: {
      ...rawParams.holder,
      enabled: holderEnabled,
    },
  });

  const config: AppConfig = {
    recipes: recipesFile.recipes,
    models,
    params,
  };

  crossValidate(config);
  return config;
}

let cached: AppConfig | undefined;

/** Ambil konfigurasi (di-cache). Panggil `reloadConfig()` untuk memuat ulang. */
export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Muat ulang konfigurasi dari disk tanpa restart server. */
export function reloadConfig(): AppConfig {
  cached = loadConfig();
  return cached;
}

export function getRecipe(id: string): RecipeConfig | undefined {
  return getConfig().recipes.find((recipe) => recipe.id === id);
}

export function getModelByRef(ref: string): ModelConfig {
  const model = getConfig().models[ref];
  if (!model) throw new Error(`Model ref not found: ${ref}`);
  return model;
}

export function getParams(): Params {
  return getConfig().params;
}
