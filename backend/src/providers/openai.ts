import { env, getProviderApiKey } from "../env";
import { providerError } from "../lib/public-error";
import { fetchWithRetry } from "./http";
import { messagesWithSystem } from "./messages";
import { sseDataLines } from "./sse";
import {
  computeProviderCost,
  type InvokeInput,
  type InvokeResult,
  type ProviderAdapter,
  type ProviderUsage,
  type StreamChunk,
} from "./types";

const API_PATH = "/v1/chat/completions";

function apiUrl(): string {
  return `${env.openaiApiUrl}${API_PATH}`;
}

interface OpenAiChoice {
  message?: { content?: string };
  delta?: { content?: string };
}

interface OpenAiResponse {
  id: string;
  choices: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function buildBody(input: InvokeInput, stream: boolean) {
  const body: Record<string, unknown> = {
    model: input.model.model,
    messages: messagesWithSystem(input),
    stream,
  };
  if (input.maxTokens) body.max_tokens = input.maxTokens;
  if (input.json) body.response_format = { type: "json_object" };
  // Tanpa ini OpenAI tidak mengirim `usage` di respons streaming, sehingga
  // tagihan run streaming menjadi nol (provider tetap menagih kita).
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${getProviderApiKey("openai")}`,
  };
}

async function invoke(input: InvokeInput): Promise<InvokeResult> {
  const response = await fetchWithRetry(
    apiUrl(),
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(buildBody(input, false)),
    },
    { label: "OpenAI", signal: input.signal },
  );

  if (!response.ok) {
    throw providerError("openai", response.status, await response.text());
  }

  const data = (await response.json()) as OpenAiResponse;
  const usage: ProviderUsage = {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };

  return {
    output: { type: input.json ? "json" : "text", content: data.choices[0]?.message?.content ?? "" },
    usage,
    providerCostUsd: computeProviderCost(input.model, usage),
    requestRef: data.id,
  };
}

async function* stream(input: InvokeInput): AsyncGenerator<StreamChunk, InvokeResult, void> {
  const response = await fetchWithRetry(
    apiUrl(),
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(buildBody(input, true)),
    },
    { label: "OpenAI", signal: input.signal },
  );

  if (!response.ok || !response.body) {
    throw providerError("openai", response.status, await response.text());
  }

  let text = "";
  let requestRef = "";
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const data of sseDataLines(response.body)) {
    if (data === "[DONE]") break;
    let event: OpenAiResponse;
    try {
      event = JSON.parse(data) as OpenAiResponse;
    } catch {
      continue;
    }
    requestRef = event.id ?? requestRef;
    const delta = event.choices[0]?.delta?.content;
    if (delta) {
      text += delta;
      yield { delta };
    }
    if (event.usage) {
      inputTokens = event.usage.prompt_tokens ?? inputTokens;
      outputTokens = event.usage.completion_tokens ?? outputTokens;
    }
  }

  const usage: ProviderUsage = { inputTokens, outputTokens };
  return {
    output: { type: "text", content: text },
    usage,
    providerCostUsd: computeProviderCost(input.model, usage),
    requestRef,
  };
}

export const openaiAdapter: ProviderAdapter = {
  name: "openai",
  invoke,
  stream,
};
