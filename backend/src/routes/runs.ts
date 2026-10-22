import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { estimateRecipe } from "../billing/estimate";
import { db } from "../db";
import { runs, runSteps } from "../db/schema";
import { env } from "../env";
import { ApiError } from "../lib/http";
import { requireProject } from "../middleware/auth";
import { projectRunsLimiter } from "../middleware/rate-limit";
import { createRun, getRun } from "../orchestration/create-run";
import { runEvents } from "../orchestration/events";
import { executeRun } from "../orchestration/runner";
import { suggestRecipe } from "../orchestration/router";
import { serializeRun } from "../serialize";
import { CONVERSATION_ID_PATTERN, dropConversationIfEmpty } from "../services/conversations";
import type { ChatMessage } from "../providers";
import type { AppEnv } from "../types";
import { estimateToApi } from "./recipes";

const TERMINAL = new Set(["SETTLED", "RELEASED", "INSUFFICIENT_BALANCE"]);

export const runRoutes = new Hono<AppEnv>();
runRoutes.use("*", requireProject);

// Penjaga belanja provider per project (batas murah hati, anti-abuse).
const limitRuns = projectRunsLimiter(env.rateLimitWindowMs, env.rateLimitRunsPerMin);

const createSchema = z.object({
  recipe_id: z.string().max(64).optional(),
  // Batas panjang: input & riwayat disimpan ke DB dan dikirim ke provider, jadi
  // tanpa plafon klien bisa mendorong payload raksasa. Nilainya longgar
  // (20k karakter per pesan) sehingga tidak menghalangi prompt panjang yang wajar.
  input: z.string().min(1).max(20_000),
  // Format dibatasi: id percakapan dibuat server, jadi yang sah hanya id yang
  // pernah dikirim server. Nilai ngawur ditolak 400 sebelum menyentuh DB.
  conversation_id: z.string().regex(CONVERSATION_ID_PATTERN, "Invalid conversation id.").optional(),
  // v1: `history` dari klien tetap diterima dan DIHORMATI bila dikirim. UI web
  // tidak lagi mengirimnya — run ber-`conversation_id` tanpa `history` memakai
  // konteks dari tabel `messages` (lihat `executeRun`), yang memuat seluruh turn.
  history: z
    .array(z.object({ role: z.string().max(32), content: z.string().max(20_000) }))
    .max(50)
    .optional(),
});

/**
 * Opsi eksekusi bersama: teruskan delta token ke bus event run agar klien SSE
 * (web chat) menerima streaming teks, bukan hanya event step.
 */
function runOptions(runId: string, history?: ChatMessage[]) {
  return {
    summary: null as string | null,
    history,
    onDelta: (text: string) => runEvents.emit(runId, { type: "delta", text }),
  };
}

/** Buat & jalankan run. Media memerlukan konfirmasi terpisah. */
runRoutes.post("/", limitRuns, async (c) => {
  const project = c.get("project");
  const body = createSchema.parse(await c.req.json());
  const totalChars =
    body.input.length + (body.history?.reduce((sum, message) => sum + message.content.length, 0) ?? 0);
  if (totalChars > env.maxRequestChars) {
    throw new ApiError(
      413,
      "REQUEST_TOO_LARGE",
      `Request is too large (${totalChars} characters; limit ${env.maxRequestChars}).`,
    );
  }
  const recipeId = body.recipe_id ?? suggestRecipe(body.input);
  const idempotencyKey = c.req.header("Idempotency-Key");

  const created = await createRun({
    projectId: project.id,
    recipeId,
    input: body.input,
    conversationId: body.conversation_id,
    idempotencyKey,
  });

  const estimate = estimateToApi(
    estimateRecipe(created.recipe),
    created.recipe.pricing.requires_confirmation,
  );

  // Resep media berhenti di sini sampai dikonfirmasi.
  if (created.run.status === "AWAITING_CONFIRMATION") {
    return c.json(
      {
        run_id: created.run.id,
        status: "AWAITING_CONFIRMATION",
        estimate,
        is_trial: created.isTrial,
        conversation_id: created.conversationId,
      },
      202,
    );
  }

  // Idempotent: jangan eksekusi ulang run yang sudah berjalan/selesai, dan jangan
  // eksekusi run hasil replay walau statusnya masih `CREATED` — permintaan yang
  // memakai Idempotency-Key itu lebih dulu yang menjalankannya
  // (lihat `CreatedRun.replayed`). Tanpa penjagaan ini, dua permintaan konkuren
  // dengan key sama bisa menagih biaya provider dua kali.
  if (created.run.status !== "CREATED" || created.replayed) {
    return c.json(
      {
        run_id: created.run.id,
        status: created.run.status,
        estimate,
        is_trial: created.isTrial,
        conversation_id: created.conversationId,
      },
      200,
    );
  }

  void executeRun(
    created.run.id,
    runOptions(
      created.run.id,
      body.history as ChatMessage[] | undefined,
    ),
  ).catch((error) => {
    console.error(`[run ${created.run.id}] gagal:`, error);
  });

  return c.json(
    {
      run_id: created.run.id,
      status: created.run.status,
      estimate,
      is_trial: created.isTrial,
      conversation_id: created.conversationId,
    },
    202,
  );
});

runRoutes.get("/:id", async (c) => {
  const project = c.get("project");
  const run = await getRun(c.req.param("id"));
  if (!run || run.projectId !== project.id) {
    throw new ApiError(404, "RUN_NOT_FOUND", "Run not found.");
  }
  const steps = await db
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, run.id));
  return c.json(serializeRun(run, steps));
});

runRoutes.get("/:id/events", async (c) => {
  const project = c.get("project");
  const runId = c.req.param("id");
  const run = await getRun(runId);
  if (!run || run.projectId !== project.id) {
    throw new ApiError(404, "RUN_NOT_FOUND", "Run not found.");
  }

  return streamSSE(c, async (stream) => {
    // Replay event yang sudah lewat.
    for (const event of runEvents.past(runId)) {
      await stream.writeSSE({ data: JSON.stringify(event) });
    }

    if (TERMINAL.has(run.status)) {
      await stream.writeSSE({ data: JSON.stringify({ type: "done", status: run.status }) });
      return;
    }

    await new Promise<void>((resolve) => {
      const unsubscribe = runEvents.subscribe(runId, (event) => {
        void stream.writeSSE({ data: JSON.stringify(event) });
        if (event.type === "done") {
          unsubscribe();
          resolve();
        }
      });
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ data: JSON.stringify({ type: "ping" }) });
      }, 5_000);
      stream.onAbort(() => {
        unsubscribe();
        clearInterval(heartbeat);
        resolve();
      });
    });
  });
});

/**
 * Batalkan run yang belum dikonfirmasi.
 *
 * Baris run **dihapus**, bukan di-`RELEASED`: run yang berhenti di
 * AWAITING_CONFIRMATION belum pernah memanggil provider, belum menahan
 * reservasi, dan belum punya entri ledger — jadi menghapusnya mengembalikan
 * kuota umum **dan** jatah media seketika, tanpa menunggu reaper (default 24 jam).
 *
 * Aman dari penyalahgunaan: hanya status AWAITING_CONFIRMATION yang boleh
 * dihapus, sedangkan run yang sudah dikonfirmasi kontribusinya permanen. Karena
 * gate di `createRun` menghitung SEMUA run (termasuk yang belum dikonfirmasi),
 * jumlah run media gratis yang bisa dijalankan tetap terbatas
 * `params.trial.free_media_attempts`.
 */
runRoutes.post("/:id/cancel", limitRuns, async (c) => {
  const project = c.get("project");
  const runId = c.req.param("id");
  const run = await getRun(runId);
  if (!run || run.projectId !== project.id) {
    throw new ApiError(404, "RUN_NOT_FOUND", "Run not found.");
  }

  // Hapus bersyarat dalam satu query supaya pembatalan konkuren hanya
  // dimenangkan satu pihak. `reserved_micro = 0` adalah jaring pengaman tambahan:
  // run yang sudah menahan credit tidak boleh dihapus.
  const deleted = await db
    .delete(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, "AWAITING_CONFIRMATION"),
        eq(runs.reservedMicro, 0),
      ),
    )
    .returning({ id: runs.id });

  if (deleted.length === 0) {
    const current = await getRun(runId);
    throw new ApiError(
      400,
      "INVALID_STATUS",
      `Run is not in AWAITING_CONFIRMATION state (current: ${current?.status ?? "unknown"}).`,
    );
  }

  // Run terakhirnya hilang → percakapan ini tidak akan muncul di riwayat dan
  // tidak bisa dibuka secara bermakna; hapus supaya id-nya tidak menggantung.
  await dropConversationIfEmpty(run.conversationId);

  // Lepaskan klien SSE (bila ada) agar tidak menggantung menunggu run yang hilang.
  runEvents.emit(runId, { type: "done", status: "CANCELLED" });

  return c.json({ run_id: runId, status: "CANCELLED" }, 200);
});

runRoutes.post("/:id/confirm", limitRuns, async (c) => {
  const project = c.get("project");
  const runId = c.req.param("id");
  const run = await getRun(runId);
  if (!run || run.projectId !== project.id) {
    throw new ApiError(404, "RUN_NOT_FOUND", "Run not found.");
  }
  // Klaim atomik: transisi bersyarat AWAITING_CONFIRMATION → RESERVED dalam
  // satu query, sehingga konfirmasi konkuren hanya dimenangkan satu pihak
  // (yang kalah mendapat 400, bukan run kedua yang ikut ditagih).
  const claimed = await db
    .update(runs)
    .set({ status: "RESERVED" })
    .where(and(eq(runs.id, runId), eq(runs.status, "AWAITING_CONFIRMATION")))
    .returning({ id: runs.id });

  if (claimed.length === 0) {
    const current = await getRun(runId);
    throw new ApiError(
      400,
      "INVALID_STATUS",
      `Run is not in AWAITING_CONFIRMATION state (current: ${current?.status ?? "unknown"}).`,
    );
  }

  void executeRun(runId, runOptions(runId)).catch((error) => {
    console.error(`[run ${runId}] gagal:`, error);
  });

  return c.json({ run_id: runId, status: "RUNNING" }, 202);
});

