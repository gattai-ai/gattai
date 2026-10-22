import type { Recipe } from "./types";

/**
 * Nama provider internal → merek publik. API sudah mengirim nama publik di
 * field `provider`, tapi helper di sini menjadi jaring pengaman agar provider
 * internal (mis. `mimo`) tidak pernah bocor walau ada response lama.
 */
const PUBLIC_PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Claude",
  openai: "GPT",
  perplexity: "Perplexity",
  higgsfield: "Higgsfield",
  mimo: "Model",
};

const FALLBACK_PROVIDER_NAME = "Model";

/** Nama provider yang tampil ke pengguna. */
export function displayStepLabel(step: { label?: string | null; provider?: string }): string {
  if (step.label) return step.label;
  const provider = step.provider ?? "";
  return PUBLIC_PROVIDER_NAMES[provider] ?? (provider || FALLBACK_PROVIDER_NAME);
}

/** Teks role yang tampil di app (Chat/Usage); `role_label` dari config. */
export function displayStepRole(step: { role_label?: string | null; role: string }): string {
  return step.role_label ?? step.role;
}

/** Label mode kartu formasi di landing, mengikuti `gattai-site/index.html`. */
const MODE_LABELS: Record<string, string> = {
  streaming: "Streaming",
  async: "Async",
  mixed: "Mixed",
};

/** `streaming` → `Streaming` (id mode dari config → label tampilan landing). */
export function displayModeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? (mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : mode);
}

/**
 * Teks role untuk kartu formasi di landing, mengikuti frasa pendek
 * `gattai-site/index.html` (beda dari `role_label` config yang dipakai Chat &
 * Usage).
 *
 * Kuncinya adalah `role_label`, bukan `role`: `visual` dan `launch_kit` sama-sama
 * memakai role `render_image`, jadi pemetaan berbasis `role` tak bisa membedakan
 * `image` dari `banner/PFP`. Role yang tidak punya padanan jatuh ke label apa
 * adanya.
 */
const LANDING_ROLE_LABELS: Record<string, string> = {
  gather_sources: "gather",
  art_direction: "art direction",
  script_and_shots: "script & shots",
  copy_pack: "copy pack",
  "render · image": "image",
  "render · video": "Veo / Kling",
  "render · banner": "banner/PFP",
};

export function displayLandingRole(step: { role_label?: string | null; role: string }): string {
  const label = step.role_label ?? step.role;
  return LANDING_ROLE_LABELS[label] ?? label;
}

/** Satu step formasi yang sudah siap dirender (label + role publik). */
export interface DisplayRecipeStep {
  label: string;
  role: string;
}

/** Satu kartu formasi di landing. */
export interface DisplayRecipe {
  id: string;
  name: string;
  mode: string;
  steps: DisplayRecipeStep[];
  /** `false` = coming soon (lihat `Recipe.available`). */
  available?: boolean;
}

/**
 * Bentuk kartu formasi dari response API; daftar statis dipakai saat belum ada
 * data (mis. pengunjung anonim yang tidak memuat `/v1/recipes`).
 */
export function toDisplayRecipes(
  recipes: Recipe[] | null | undefined,
  fallback: DisplayRecipe[],
): DisplayRecipe[] {
  if (!recipes || recipes.length === 0) return fallback;
  return recipes.map((recipe) => ({
    id: recipe.id,
    name: recipe.name,
    mode: displayModeLabel(recipe.mode),
    available: recipe.available,
    steps: recipe.steps.map((step) => ({
      label: displayStepLabel(step),
      role: displayLandingRole(step),
    })),
  }));
}
