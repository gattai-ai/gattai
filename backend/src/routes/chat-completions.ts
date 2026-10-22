import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { env } from "../env";
import { ApiError } from "../lib/http";
import { newId } from "../lib/id";
import { requireProject } from "../middleware/auth";
import { projectRunsLimiter } from "../middleware/rate-limit";
import { createRun, type RunRow } from "../orchestration/create-run";
import { executeRun } from "../orchestration/runner";
import { summarizeHistory } from "../orchestration/summarize";
import type { ChatMessage } from "../providers";
import type { AppEnv } from "../types";

/**
 * Endpoint kompatibel OpenAI. Setiap recipe teks diekspos sebagai virtual model:
 *   gattai/refine, gattai/research, gattai/code.
 * Key bisa dipasang ke Cursor, Claude Code, atau SDK lain yang kompatibel.
 */
const ALLOWED_MODELS = new Set(["gattai/refine", "gattai/research", "gattai/code"]);

const messageSchema = z.object({ role: z.string(), content: z.string() });
const bodySchema = z.object({
  model: z.string(),
  messages: z.array(messageSchema).max(200),
  stream: z.boolean().optional(),
});

export const chatCompletionsRoutes = new Hono<AppEnv>();
chatCompletionsRoutes.use("*", requireProject);

// Penjaga belanja provider per project (sama seperti POST /v1/runs).
const limitRuns = projectRunsLimiter(env.rateLimitWindowMs, env.rateLimitRunsPerMin);

chatCompletionsRoutes.post("/", limitRuns, async (c) => {
  const body = bodySchema.parse(await c.req.json());
  if (!ALLOWED_MODELS.has(body.model)) {
    throw new ApiError(404, "MODEL_NOT_FOUND", `Model not available: ${body.model}`);
  }
  const recipeId = body.model.split("/")[1];

  // Batas biaya hulu: ukuran konteks menentukan biaya input. Estimasi
  // reservasi memakai angka tetap, jadi request raksasa harus ditolak di sini.
  const totalChars = body.messages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalChars > env.maxRequestChars) {
    throw new ApiError(
      413,
      "REQUEST_TOO_LARGE",
      `Request is too large (${totalChars} characters; limit ${env.maxRequestChars}).`,
    );
  }

  const messages = body.messages as ChatMessage[];
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  if (lastUserIndex < 0) {
    throw new ApiError(400, "BAD_REQUEST", "At least one user message is required.");
  }
  const input = messages[lastUserIndex].content;
  const history = messages
    .slice(0, lastUserIndex)
    .filter((m) => m.role === "user" || m.role === "assistant") as ChatMessage[];

  const project = c.get("project");
  const created = await createRun({
    projectId: project.id,
    recipeId,
    input,
    // Tanpa percakapan: klien API sudah mengirim konteks sendiri di `messages`,
    // jadi membukanya hanya mengotori riwayat web dengan entri satu-turn dan
    // menambah biaya ringkasan yang tak terpakai.
    openConversation: false,
    idempotencyKey: c.req.header("Idempotency-Key") ?? newId("idem"),
  });

  if (created.run.status === "AWAITING_CONFIRMATION") {
    throw new ApiError(400, "CONFIRMATION_REQUIRED", "This recipe requires an estimate confirmation.");
  }

  const completionId = `chatcmpl-${created.run.id}`;
  const createdTs = Math.floor(Date.now() / 1000);

  // Idempotent: jika run sudah ada/berjalan, jangan eksekusi ulang. Replay
  // Idempotency-Key juga tidak dieksekusi lagi (lihat `CreatedRun.replayed`).
  const needsRun = created.run.status === "CREATED" && !created.replayed;
  const storedContent = () => {
    const out = created.run.output as { content?: string } | null;
    return typeof out?.content === "string" ? out.content : "";
  };

  // Ringkas riwayat panjang sebelum eksekusi (biayanya dibebankan ke run).
  let runHistory = history;
  let runSummary: string | null = null;
  let extraProviderCostUsd = 0;
  if (needsRun) {
    const summarized = await summarizeHistory(history);
    runHistory = summarized.history;
    runSummary = summarized.summary;
    extraProviderCostUsd = summarized.providerCostUsd;
  }

  // Status final run (diperbarui setelah eksekusi).
  let runStatus: RunRow["status"] = created.run.status;

  if (body.stream) {
    return streamSSE(c, async (stream) => {
      const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: unknown) => ({
        id: completionId,
        object: "chat.completion.chunk",
        created: createdTs,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      });

      await stream.writeSSE({
        data: JSON.stringify(chunk({ role: "assistant", content: "" }, null)),
      });

      if (!needsRun) {
        const content = storedContent();
        if (content) {
          await stream.writeSSE({ data: JSON.stringify(chunk({ content }, null)) });
        }
      } else {
        const result = await executeRun(created.run.id, {
          history: runHistory,
          summary: runSummary,
          extraProviderCostUsd,
          onDelta: (text) => {
            void stream.writeSSE({
              data: JSON.stringify(chunk({ content: text }, null)),
            });
          },
        });
        runStatus = result.status;
      }

      await stream.writeSSE({ data: JSON.stringify(chunk({}, "stop")) });
      await stream.writeSSE({
        data: JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTs,
          model: body.model,
          choices: [],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            gattai_status: runStatus,
          },
        }),
      });
      await stream.writeSSE({ data: "[DONE]" });
    });
  }

  let content = storedContent();
  if (needsRun) {
    const result = await executeRun(created.run.id, {
      history: runHistory,
      summary: runSummary,
      extraProviderCostUsd,
    });
    runStatus = result.status;
    const output = result.output as { content?: string } | null;
    content =
      typeof output?.content === "string" && output.content
        ? output.content
        : result.output
          ? JSON.stringify(result.output)
          : "";
  }

  return c.json({
    id: completionId,
    object: "chat.completion",
    created: createdTs,
    model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    gattai: { run_id: created.run.id, status: runStatus },
  });
});
