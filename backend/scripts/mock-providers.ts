/**
 * Mock provider server untuk pengembangan/uji tanpa API key asli.
 *
 * Meniru bentuk minimal Anthropic, OpenAI, dan Perplexity sehingga seluruh
 * pipeline GATTAI (interpreter → orchestrator → SSE → billing) bisa dijalankan
 * end-to-end secara lokal.
 *
 * Jalankan:
 *   bun run mock:providers
 *
 * Lalu arahkan provider ke server ini (lihat backend/.env.example):
 *   ANTHROPIC_API_URL=http://localhost:4319
 *   OPENAI_API_URL=http://localhost:4319
 *   PERPLEXITY_API_URL=http://localhost:4319
 *   MIMO_API_URL=http://localhost:4319
 */

const CLAUDE_TEXT = "MOCK-CLAUDE-OK: hasil contoh dari provider tiruan.";
const OPENAI_TEXT = "MOCK-OPENAI-OK";
const PERPLEXITY_TEXT = "MOCK-PERPLEXITY-OK: temuan contoh.";
const BRIEF_JSON = JSON.stringify({
  pass_through: true,
  goal: "mock goal",
  assumptions: ["dijalankan dalam mode mock"],
});

interface MockBody {
  stream?: boolean;
  model?: string;
  response_format?: { type?: string };
  messages?: Array<{ role?: string; content?: string }>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function sseData(payload: string): string {
  return `data: ${payload}\n\n`;
}

async function readBody(request: Request): Promise<MockBody> {
  try {
    return (await request.json()) as MockBody;
  } catch {
    return {};
  }
}

function openAiContent(body: MockBody): string {
  return body.response_format?.type === "json_object" ? BRIEF_JSON : OPENAI_TEXT;
}

async function handleAnthropic(request: Request): Promise<Response> {
  const body = await readBody(request);
  if (!body.stream) {
    return json({
      id: "msg_mock",
      content: [{ type: "text", text: CLAUDE_TEXT }],
      usage: { input_tokens: 120, output_tokens: 30 },
    });
  }
  const payload =
    sseData(
      JSON.stringify({
        type: "message_start",
        message: { id: "msg_mock", usage: { input_tokens: 120 } },
      }),
    ) +
    CLAUDE_TEXT.split(" ")
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
    sseData(JSON.stringify({ type: "message_stop" })) +
    sseData("[DONE]");
  return sse(payload);
}

async function handleOpenAi(request: Request): Promise<Response> {
  const body = await readBody(request);
  const content = openAiContent(body);
  if (!body.stream) {
    return json({
      id: "chatcmpl-mock",
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    });
  }
  const payload =
    sseData(
      JSON.stringify({ id: "chatcmpl-mock", choices: [{ delta: { role: "assistant" } }] }),
    ) +
    sseData(JSON.stringify({ id: "chatcmpl-mock", choices: [{ delta: { content } }] })) +
    sseData(
      JSON.stringify({
        id: "chatcmpl-mock",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 80, completion_tokens: 20 },
      }),
    ) +
    sseData("[DONE]");
  return sse(payload);
}

async function handlePerplexity(request: Request): Promise<Response> {
  await readBody(request);
  return json({
    id: "pplx-mock",
    choices: [{ message: { role: "assistant", content: PERPLEXITY_TEXT } }],
    citations: ["https://example.com/mock-source"],
    usage: { prompt_tokens: 60, completion_tokens: 15 },
  });
}

const DEFAULT_PORT = Number(process.env.MOCK_PORT ?? 4319);

export function startMockProviders(port: number = DEFAULT_PORT) {
  return Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return json({ status: "ok", mock: true });
      if (request.method !== "POST") return json({ error: "not found" }, 404);

      switch (url.pathname) {
        case "/v1/messages":
          return handleAnthropic(request);
        case "/v1/chat/completions":
          return handleOpenAi(request);
        case "/chat/completions":
          // MIMO (OpenAI-compat, header `api-key:`) berbagi path dengan
          // Perplexity; bedakan lewat header agar streaming + brief JSON mock
          // tetap jalan untuk E2E offline.
          if (request.headers.has("api-key")) return handleOpenAi(request);
          return handlePerplexity(request);
        default:
          return json({ error: `no mock route for ${url.pathname}` }, 404);
      }
    },
  });
}

if (import.meta.main) {
  const server = startMockProviders();
  console.log(`Mock provider server berjalan di http://localhost:${server.port}`);
  console.log(
    "Arahkan ANTHROPIC_API_URL / OPENAI_API_URL / PERPLEXITY_API_URL ke URL ini.",
  );
}
