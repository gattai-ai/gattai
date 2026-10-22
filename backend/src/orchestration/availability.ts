import type { RecipeConfig } from "../config";
import { isProviderConfigured } from "../env";

/**
 * Ketersediaan formasi = apakah **semua** provider yang dipanggil step-nya
 * punya kredensial.
 *
 * Satu-satunya sumber kebenaran untuk dua konsumen: UI (badge "coming soon" di
 * `/v1/recipes` dan `/v1/public/formations`) dan guard di pintu masuk run
 * (`createRun`). Karena itu aturannya tidak boleh diduplikasi di frontend.
 *
 * Konsekuensi yang disengaja: menambah key provider otomatis menghidupkan
 * formasi terkait (tanpa deploy ulang), dan mencabut key adalah cara mematikan
 * formasi tanpa menyentuh config — tidak perlu flag manual di `recipes.yaml`.
 */

/**
 * Provider yang belum terkonfigurasi untuk recipe ini.
 *
 * Nilainya nama provider internal (`higgsfield`, …) — hanya untuk log server,
 * jangan pernah dikirim ke klien (lihat `docs/07-audit.md` §2.8).
 */
export function missingRecipeProviders(recipe: RecipeConfig): string[] {
  const providers = new Set(recipe.steps.map((step) => step.provider));
  return [...providers].filter((provider) => !isProviderConfigured(provider));
}

/** Apakah formasi ini bisa dijalankan sekarang. */
export function isRecipeAvailable(recipe: RecipeConfig): boolean {
  return missingRecipeProviders(recipe).length === 0;
}

/**
 * Pesan publik untuk formasi yang belum siap. Inggris, ramah, dan tanpa nama
 * provider/env — sama seperti kontrak `toPublicRunError` (§2.8).
 */
export const FORMATION_UNAVAILABLE_MESSAGE =
  "This formation isn't available yet. Try another one.";
