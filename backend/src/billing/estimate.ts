import { getConfig, getModelByRef, getParams, type RecipeConfig } from "../config";
import { usdToMicro } from "../lib/money";

export interface RecipeEstimate {
  providerCostUsd: number;
  chargeMicro: number;
  reserveMicro: number;
  markup: number;
}

export function resolveMarkup(recipe: RecipeConfig): number {
  return recipe.pricing.markup ?? getConfig().params.pricing.default_markup;
}

/** Estimasi biaya provider sebuah recipe (token × harga, atau harga unit media). */
export function estimateProviderCostUsd(recipe: RecipeConfig, units?: number): number {
  const { estimated_input_tokens = 0, estimated_output_tokens = 0, estimated_units = 1 } =
    recipe.pricing;

  let total = 0;
  for (const step of recipe.steps) {
    const model = getModelByRef(step.model_ref);
    if (model.kind === "text") {
      total += (estimated_input_tokens / 1_000_000) * model.input_per_mtok_usd;
      total += (estimated_output_tokens / 1_000_000) * model.output_per_mtok_usd;
    } else {
      total += model.unit_usd * (units ?? estimated_units);
    }
  }
  return total;
}

/** Biaya yang ditagih ke pengguna: biaya provider × (1 + markup). */
export function chargeMicroFromProviderCost(providerCostUsd: number, markup: number): number {
  return usdToMicro(providerCostUsd * (1 + markup));
}

/** Estimasi lengkap: biaya provider, tagihan, dan reservasi (dengan buffer). */
export function estimateRecipe(recipe: RecipeConfig, units?: number): RecipeEstimate {
  const params = getParams();
  const markup = resolveMarkup(recipe);
  const providerCostUsd = estimateProviderCostUsd(recipe, units);
  const chargeMicro = chargeMicroFromProviderCost(providerCostUsd, markup);
  const reserveMicro = Math.max(
    params.reserve.min_micro,
    Math.ceil(chargeMicro * (1 + params.reserve.buffer_ratio)),
  );
  return { providerCostUsd, chargeMicro, reserveMicro, markup };
}
