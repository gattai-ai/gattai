import type { ProviderName } from "../config";
import { anthropicAdapter } from "./anthropic";
import { higgsfieldAdapter } from "./higgsfield";
import { mimoAdapter } from "./mimo";
import { openaiAdapter } from "./openai";
import { perplexityAdapter } from "./perplexity";
import type { ProviderAdapter } from "./types";

const registry: Record<ProviderName, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  perplexity: perplexityAdapter,
  higgsfield: higgsfieldAdapter,
  mimo: mimoAdapter,
};

export function getAdapter(provider: ProviderName): ProviderAdapter {
  const adapter = registry[provider];
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  return adapter;
}

export type { ProviderName };
export * from "./types";
