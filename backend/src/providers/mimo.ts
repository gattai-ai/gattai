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

const API_PATH = "/chat/completions";

function apiUrl(): string {
  return `${env.mimoApiUrl.replace(/\/$/, "")}${API_PATH}`;
}

interface MimoChoice {
  message?: { content?: string };
  delta?: { content?: string };
}

interface MimoResponse {
  id: string;
  choices: MimoChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function buildBody(input: InvokeInput, stream: boolean) {
  const body: Record<string, unknown> = {
    // Bila pricing.yaml tidak menyebut model spesifik, pakai MIMO_MODEL.
    model: input.model.model || env.mimoModel,
    messages: messagesWithSystem(input),
    stream,
    // Token Plan: matikan chain-of-thought agar output deterministik untuk interpreter.
    thinking: { type: "disabled" },
  };
  // MIMO memakai `max_completion_tokens`, bukan `max_tokens`.
  if (input.maxTokens) body.max_completion_tokens = input.maxTokens;
  // Interpreter meminta JSON valid. Endpoint OpenAI-compat MIMO mengikuti
  // konvensi yang sama (`response_format: json_object`); bila nanti terbukti
  // tidak didukung, hapus baris ini dan andalkan ekstraksi JSON di `invoke`.
  if (input.json) body.response_format = { type: "json_object" };
  // MIMO mengikuti OpenAI: usage streaming hanya dikirim bila diminta.
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    // MIMO Token Plan memakai header `api-key:`, bukan `Authorization: Bearer`.
    "api-key": getProviderApiKey("mimo"),
  };
}

function parseUsage(data: MimoResponse): ProviderUsage {
  return {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

async function invoke(input: InvokeInput): Promise<InvokeResult> {
  const response = await fetchWithRetry(
    apiUrl(),
    { method: "POST", headers: headers(), body: JSON.stringify(buildBody(input, false)) },
    { label: "MIMO", signal: input.signal },
  );

  if (!response.ok) {
    throw providerError("mimo", response.status, await response.text());
  }

  const data = (await response.json()) as MimoResponse;
  const raw = data.choices[0]?.message?.content ?? "";
  const usage = parseUsage(data);

  // Interpreter meminta JSON: ekstrak blok JSON bila model membungkus dengan teks.
  let content = raw;
  if (input.json) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        JSON.parse(raw.slice(start, end + 1));
        content = raw.slice(start, end + 1);
      } catch {
        content = raw;
      }
    }
  }

  return {
    output: { type: input.json ? "json" : "text", content },
    usage,
    providerCostUsd: computeProviderCost(input.model, usage),
    requestRef: data.id,
  };
}

async function* stream(input: InvokeInput): AsyncGenerator<StreamChunk, InvokeResult, void> {
  const response = await fetchWithRetry(
    apiUrl(),
    { method: "POST", headers: headers(), body: JSON.stringify(buildBody(input, true)) },
    { label: "MIMO", signal: input.signal },
  );

  if (!response.ok || !response.body) {
    throw providerError("mimo", response.status, await response.text());
  }

  let text = "";
  let requestRef = "";
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const data of sseDataLines(response.body)) {
    if (data === "[DONE]") break;
    let event: MimoResponse;
    try {
      event = JSON.parse(data) as MimoResponse;
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

export const mimoAdapter: ProviderAdapter = {
  name: "mimo",
  invoke,
  stream,
};
