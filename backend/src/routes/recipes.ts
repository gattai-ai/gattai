import { Hono } from "hono";
import { getConfig } from "../config";
import { estimateRecipe, resolveMarkup } from "../billing/estimate";
import { requireProject } from "../middleware/auth";
import { microToCredits, microToUsd } from "../lib/money";
import { isRecipeAvailable } from "../orchestration/availability";
import { suggestRecipe } from "../orchestration/router";
import type { AppEnv } from "../types";

export function estimateToApi(estimate: ReturnType<typeof estimateRecipe>, requiresConfirmation: boolean) {
  return {
    credits: microToCredits(estimate.chargeMicro),
    usd: microToUsd(estimate.chargeMicro),
    reserve_micro: estimate.reserveMicro,
    provider_cost_usd: estimate.providerCostUsd,
    markup: estimate.markup,
    requires_confirmation: requiresConfirmation,
  };
}

/** Daftar recipe + estimasi harga. */
export const recipeRoutes = new Hono<AppEnv>();
recipeRoutes.use("*", requireProject);

recipeRoutes.get("/", (c) => {
  const config = getConfig();
  return c.json({
    recipes: config.recipes.map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      description: recipe.description,
      mode: recipe.mode,
      // `false` = provider yang dibutuhkan belum dikonfigurasi → UI menampilkan
      // "coming soon" dan tidak membiarkannya dipilih (guard-nya di createRun).
      available: isRecipeAvailable(recipe),
      markup: resolveMarkup(recipe),
      pricing: {
        ...recipe.pricing,
        ...estimateToApi(estimateRecipe(recipe), recipe.pricing.requires_confirmation),
      },
      steps: recipe.steps.map((step) => ({
        id: step.id,
        // `provider` di response adalah nama publik (lihat `label` di config).
        provider: step.label,
        role: step.role,
        role_label: step.role_label,
        async: step.async ?? false,
        stream: step.stream ?? false,
      })),
    })),
  });
});

/** Saran recipe berdasarkan prompt (opsional, hanya bantuan UX). */
export const routerRoutes = new Hono<AppEnv>();
routerRoutes.use("*", requireProject);
routerRoutes.post("/suggest", async (c) => {
  const body = await c.req.json<{ prompt?: string }>();
  return c.json({ recipe: suggestRecipe(body.prompt ?? "") });
});
