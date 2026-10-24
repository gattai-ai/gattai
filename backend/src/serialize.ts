import { getRecipe } from "./config";
import type { apiKeys, creditLots, ledgerEntries, runSteps, runs } from "./db/schema";
import { microToCredits, microToUsd } from "./lib/money";
import { sanitizeStoredError } from "./lib/public-error";

type Run = typeof runs.$inferSelect;
type RunStep = typeof runSteps.$inferSelect;
type LedgerEntry = typeof ledgerEntries.$inferSelect;
type CreditLot = typeof creditLots.$inferSelect;
type ApiKey = typeof apiKeys.$inferSelect;

/**
 * Nama provider internal ➜ merek publik. Dipakai sebagai jaring pengaman bila
 * langkah tidak lagi ada di config (mis. run lama), supaya nama provider asli
 * tidak pernah muncul di response API.
 */
const PUBLIC_PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Claude",
  openai: "GPT",
  perplexity: "Perplexity",
  higgsfield: "Higgsfield",
  mimo: "Model",
};

export function serializeStep(
  step: RunStep,
  options: { provider?: string; roleLabel?: string } = {},
) {
  return {
    id: step.stepId,
    // Nama provider publik (dari config recipe). Provider internal (mis. `mimo`)
    // tidak pernah dikirim ke API.
    provider: options.provider ?? PUBLIC_PROVIDER_NAMES[step.provider] ?? "Model",
    role: step.role,
    role_label: options.roleLabel ?? step.role,
    status: step.status,
    usage: {
      input_tokens: step.inputTokens,
      output_tokens: step.outputTokens,
      units: step.units != null ? Number(step.units) : null,
    },
    provider_cost_usd: Number(step.providerCostUsd),
    latency_ms: step.latencyMs,
    // Jaring pengaman untuk baris lama: teks internal yang sempat tersimpan
    // tidak pernah ikut terkirim ke API/klien.
    error: sanitizeStoredError(step.error),
  };
}

export function serializeRun(run: Run, steps?: RunStep[]) {
  // Lookup label tampilan dari versi recipe yang aktif. Run lama tetap mendapat
  // nama publik tanpa migrasi data; step yang sudah dihapus dari config jatuh
  // ke pemetaan `PUBLIC_PROVIDER_NAMES`.
  const recipe = getRecipe(run.recipeId);
  const configFor = (stepId: string) =>
    recipe?.steps.find((step) => step.id === stepId);

  return {
    run_id: run.id,
    recipe: run.recipeId,
    recipe_version: run.recipeVersion,
    status: run.status,
    mode: run.mode,
    is_trial: run.isTrial,
    is_holder: run.isHolder,
    holder_tier: run.holderTier,
    // Prompt user. Diperlukan untuk membangun ulang transkrip percakapan
    // (`GET /v1/conversations/:id`) tanpa menyimpan salinan di klien.
    input: run.input,
    output: run.output,
    cost: {
      reserved_micro: run.reservedMicro,
      charged_micro: run.chargedMicro,
      charged_credits: microToCredits(run.chargedMicro),
      charged_usd: microToUsd(run.chargedMicro),
      provider_cost_usd: Number(run.providerCostUsd),
    },
    error: sanitizeStoredError(run.error),
    created_at: run.createdAt,
    finished_at: run.finishedAt,
    steps: steps
      ? steps.map((step) =>
          serializeStep(step, {
            provider: configFor(step.stepId)?.label,
            roleLabel: configFor(step.stepId)?.role_label,
          }),
        )
      : undefined,
  };
}

export function serializeLedger(entry: LedgerEntry) {
  return {
    id: entry.id,
    run_id: entry.runId,
    lot_id: entry.lotId,
    type: entry.type,
    amount_micro: entry.amountMicro,
    amount_credits: microToCredits(entry.amountMicro),
    balance_after_micro: entry.balanceAfterMicro,
    balance_after_credits: microToCredits(entry.balanceAfterMicro),
    created_at: entry.createdAt,
  };
}

export function serializeLot(lot: CreditLot) {
  return {
    id: lot.id,
    source: lot.source,
    deposit_tx: lot.depositTx,
    amount_micro: lot.amountMicro,
    remaining_micro: lot.remainingMicro,
    amount_credits: microToCredits(lot.amountMicro),
    remaining_credits: microToCredits(lot.remainingMicro),
    created_at: lot.createdAt,
  };
}

export function serializeApiKey(key: ApiKey) {
  return {
    id: key.id,
    prefix: key.prefix,
    label: key.label,
    created_at: key.createdAt,
    revoked_at: key.revokedAt,
    last_used_at: key.lastUsedAt,
  };
}
