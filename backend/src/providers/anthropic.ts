import { env, getProviderApiKey } from "../env";
import { providerError } from "../lib/public-error";
import { fetchWithRetry } from "./http";
import { sseDataLines } from "./sse";
import {
  computeProviderCost,
  type ChatMessage,
  type InvokeInput,
  type InvokeResult,
  type ProviderAdapter,
  type ProviderUsage,
  type StreamChunk,
} from "./types";

const API_PATH = "/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicResponse {
  id: string;
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type CacheControl = { type: "ephemeral" };
type ContentBlock = { type: "text"; text: string; cache_control?: CacheControl };
type AnthropicMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };

function apiUrl(): string {
  return `${env.anthropicApiUrl}${API_PATH}`;
}

/**
 * Prompt caching (Anthropic).
 *
 * Kami menandai dua titik cache (`cache_control: ephemeral`):
 *   1. system prompt  — stabil lintas request pada role yang sama;
 *   2. pesan sebelum pesan user terakhir — meng-cache prefix percakapan
 *      sehingga turn berikutnya hanya membayar token baru.
 *
 * Jika total token berada di bawah ambang minimum cache Anthropic, penanda ini
 * diabaikan oleh API (tetap valid, hanya tidak menghasilkan penghematan).
 */
function buildBody(input: InvokeInput, stream: boolean) {
  const conversation: ChatMessage[] = input.messages.filter((m) => m.role !== "system");
  const lastHistoricalIndex = conversation.length - 2;

  const messages: AnthropicMessage[] = conversation.map((m, index) => {
    const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
    if (index === lastHistoricalIndex) {
      return { role, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] };
    }
    return { role, content: m.content };
  });

  const body: Record<string, unknown> = {
    model: input.model.model,
    max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    stream,
  };

  if (input.system) {
    body.system = [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }];
  }

  return body;
}

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": getProviderApiKey("anthropic"),
    "anthropic-version": API_VERSION,
  };
}

function textFrom(res: AnthropicResponse): string {
  return res.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

async function invoke(input: InvokeInput): Promise<InvokeResult> {
  const response = await fetchWithRetry(
    apiUrl(),
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(buildBody(input, false)),
    },
    { label: "Anthropic", signal: input.signal },
  );

  if (!response.ok) {
    throw providerError("anthropic", response.status, await response.text());
  }

  const data = (await response.json()) as AnthropicResponse;
  const usage: ProviderUsage = {
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };

  return {
    output: { type: "text", content: textFrom(data) },
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
    { label: "Anthropic", signal: input.signal },
  );

  if (!response.ok || !response.body) {
    throw providerError("anthropic", response.status, await response.text());
  }

  let text = "";
  let requestRef = "";
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const data of sseDataLines(response.body)) {
    if (data === "[DONE]") break;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = event.type;
    if (type === "message_start") {
      const message = event.message as AnthropicResponse | undefined;
      requestRef = message?.id ?? requestRef;
      inputTokens = message?.usage?.input_tokens ?? inputTokens;
    } else if (type === "content_block_delta") {
      const delta = event.delta as { text?: string } | undefined;
      if (delta?.text) {
        text += delta.text;
        yield { delta: delta.text };
      }
    } else if (type === "message_delta") {
      const usage = event.usage as { output_tokens?: number } | undefined;
      outputTokens = usage?.output_tokens ?? outputTokens;
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

export const anthropicAdapter: ProviderAdapter = {
  name: "anthropic",
  invoke,
  stream,
};
