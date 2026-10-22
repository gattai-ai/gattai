import { env, getProviderApiKey } from "../env";
import { providerError } from "../lib/public-error";
import { fetchWithRetry } from "./http";
import { messagesWithSystem } from "./messages";
import {
  computeProviderCost,
  type InvokeInput,
  type InvokeResult,
  type ProviderAdapter,
  type ProviderUsage,
} from "./types";

const API_PATH = "/chat/completions";

function apiUrl(): string {
  return `${env.perplexityApiUrl}${API_PATH}`;
}

interface PerplexityResponse {
  id: string;
  choices: Array<{ message?: { content?: string } }>;
  citations?: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Perplexity (Sonar) bersifat OpenAI-compatible. Step ini selalu non-final
 * (hasilnya dipakai Claude), jadi tidak perlu streaming.
 */
async function invoke(input: InvokeInput): Promise<InvokeResult> {
  const response = await fetchWithRetry(
    apiUrl(),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${getProviderApiKey("perplexity")}`,
      },
      body: JSON.stringify({
        model: input.model.model,
        messages: messagesWithSystem(input),
        max_tokens: input.maxTokens,
      }),
    },
    { label: "Perplexity", signal: input.signal },
  );

  if (!response.ok) {
    throw providerError("perplexity", response.status, await response.text());
  }

  const data = (await response.json()) as PerplexityResponse;
  const usage: ProviderUsage = {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };

  return {
    output: {
      type: "text",
      content: data.choices[0]?.message?.content ?? "",
      citations: data.citations ?? [],
    },
    usage,
    providerCostUsd: computeProviderCost(input.model, usage),
    requestRef: data.id,
  };
}

export const perplexityAdapter: ProviderAdapter = {
  name: "perplexity",
  invoke,
};
