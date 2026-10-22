/**
 * Helper mock `fetch` untuk test: meniru bentuk respons Anthropic, OpenAI, dan
 * Perplexity tanpa koneksi keluar.
 */

export const CLAUDE_TEXT = "MOCK-CLAUDE-OK";
export const OPENAI_TEXT = "MOCK-OPENAI-OK";
export const PERPLEXITY_TEXT = "MOCK-PERPLEXITY-OK";
export const BRIEF_JSON = JSON.stringify({ pass_through: true, goal: "mock goal" });

export type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function sseData(payload: string): string {
  return `data: ${payload}\n\n`;
}

function anthropicStream(text: string): string {
  const words = text.split(" ");
  return (
    sseData(
      JSON.stringify({
        type: "message_start",
        message: { id: "msg_mock", usage: { input_tokens: 120 } },
      }),
    ) +
    words
      .map((word, index) =>
        sseData(
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: index === 0 ? word : ` ${word}` },
          }),
        ),
      )
      .join("") +
    sseData(JSON.stringify({ type: "message_delta", usage: { output_tokens: 30 } })) +
    sseData("[DONE]")
  );
}

function openaiStream(content: string): string {
  return (
    sseData(JSON.stringify({ id: "chatcmpl-mock", choices: [{ delta: { role: "assistant" } }] })) +
    sseData(JSON.stringify({ id: "chatcmpl-mock", choices: [{ delta: { content } }] })) +
    sseData(
      JSON.stringify({
        id: "chatcmpl-mock",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 80, completion_tokens: 20 },
      }),
    ) +
    sseData("[DONE]")
  );
}

interface MockOptions {
  anthropicStatus?: number;
  openaiStatus?: number;
  perplexityStatus?: number;
  /** Status paksa untuk request MIMO (header `api-key:`). */
  mimoStatus?: number;
  /**
   * Bila true, hanya request MIMO non-JSON (step executor) yang digagalkan;
   * request interpreter (`response_format: json_object`) tetap sukses.
   * Untuk menguji tagihan parsial saat executor gagal.
   */
  mimoFailExecuteOnly?: boolean;
}

function isMimo(init?: RequestInit): boolean {
  const headers = init?.headers;
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has("api-key");
  if (Array.isArray(headers)) return headers.some(([k]) => String(k).toLowerCase() === "api-key");
  return Object.keys(headers).some((k) => k.toLowerCase() === "api-key");
}

export function makeMockFetch(options: MockOptions = {}): FetchHandler {
  return async (input, init) => {
    const url = String(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as {
          stream?: boolean;
          response_format?: { type?: string };
        })
      : {};
    const mimo = isMimo(init);
    const isJsonRequest = body.response_format?.type === "json_object";

    if (url.includes("/v1/messages")) {
      const status = options.anthropicStatus ?? 200;
      if (status !== 200) return new Response("anthropic error", { status });
      if (body.stream) return sseResponse(anthropicStream(CLAUDE_TEXT));
      return jsonResponse({
        id: "msg_mock",
        content: [{ type: "text", text: CLAUDE_TEXT }],
        usage: { input_tokens: 120, output_tokens: 30 },
      });
    }

    if (url.includes("/v1/chat/completions")) {
      const status = mimo ? (options.mimoStatus ?? 200) : (options.openaiStatus ?? 200);
      if (status !== 200) {
        // Mode executor-saja: interpreter (request JSON) tetap sukses agar
        // tagihan parsial bisa diuji.
        if (!(mimo && options.mimoFailExecuteOnly && isJsonRequest)) {
          return new Response("openai error", { status });
        }
      }
      const content = body.response_format?.type === "json_object" ? BRIEF_JSON : OPENAI_TEXT;
      if (body.stream) return sseResponse(openaiStream(content));
      return jsonResponse({
        id: "chatcmpl-mock",
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 80, completion_tokens: 20 },
      });
    }

    if (url.includes("/chat/completions")) {
      const status = options.perplexityStatus ?? 200;
      if (status !== 200) return new Response("perplexity error", { status });
      return jsonResponse({
        id: "pplx-mock",
        choices: [{ message: { role: "assistant", content: PERPLEXITY_TEXT } }],
        citations: ["https://example.com/mock-source"],
        usage: { prompt_tokens: 60, completion_tokens: 15 },
      });
    }

    return new Response("not found", { status: 404 });
  };
}

/** Pasang handler fetch; kembalikan fungsi untuk mengembalikan fetch asli. */
export function installFetch(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
