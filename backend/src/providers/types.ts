import type { ModelConfig, ProviderName, RecipeStep } from "../config";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Spec media yang divalidasi dari output Claude untuk recipe visual/video. */
export interface MediaSpec {
  model_hint?: string;
  prompt: string;
  negative_prompt?: string;
  aspect_ratio?: string;
  duration_s?: number;
  audio?: boolean;
  shots?: Array<{ t: number; desc: string }>;
}

export interface InvokeInput {
  model: ModelConfig;
  step: RecipeStep;
  system?: string;
  messages: ChatMessage[];
  /** Untuk step media: spec terstruktur dari step sebelumnya. */
  media?: MediaSpec;
  maxTokens?: number;
  /** Meminta output JSON valid (mis. interpreter). */
  json?: boolean;
  signal?: AbortSignal;
}

export type OutputType = "text" | "json" | "image" | "video" | "audio";

export interface ProviderOutput {
  type: OutputType;
  content?: string;
  data?: unknown;
  url?: string;
  citations?: string[];
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  units?: number;
}

export interface InvokeResult {
  output: ProviderOutput;
  usage: ProviderUsage;
  providerCostUsd: number;
  requestRef: string;
}

export interface StreamChunk {
  delta?: string;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  invoke(input: InvokeInput): Promise<InvokeResult>;
  /** Opsional: streaming token demi token (untuk step terakhir recipe teks). */
  stream?(input: InvokeInput): AsyncGenerator<StreamChunk, InvokeResult, void>;
}

/** Biaya provider dari laporan usage dengan tabel harga model. */
export function computeProviderCost(model: ModelConfig, usage: ProviderUsage): number {
  if (model.kind === "text") {
    const inCost = ((usage.inputTokens ?? 0) / 1_000_000) * model.input_per_mtok_usd;
    const outCost = ((usage.outputTokens ?? 0) / 1_000_000) * model.output_per_mtok_usd;
    return inCost + outCost;
  }
  return model.unit_usd * (usage.units ?? 1);
}
