import { and, eq, inArray } from "drizzle-orm";
import {
  getModelByRef,
  getParams,
  getRecipe,
  type RecipeConfig,
  type RecipeStep,
} from "../config";
import { db } from "../db";
import { runSteps, runs } from "../db/schema";
import { chargeMicroFromProviderCost, estimateRecipe, resolveMarkup } from "../billing/estimate";
import { release, reserve, settleRun } from "../billing/ledger";
import { env } from "../env";
import { newId } from "../lib/id";
import {
  RunLimitReachedError,
  internalErrorDetail,
  toPublicRunError,
} from "../lib/public-error";
import { getAdapter, type ChatMessage, type InvokeResult, type MediaSpec } from "../providers";
import { runEvents, type RunEvent } from "./events";
import { runInterpreter, type InterpreterBrief } from "./interpreter";
import { mediaSpecSchema, parseJsonFromText } from "./media-spec";
import {
  appendRunMessages,
  ensureConversation,
  getConversationContext,
  maybeRefreshSummary,
} from "../services/conversations";
import {
  GATTAI_SYSTEM,
  REVIEWER_SYSTEM,
  buildOriginalPlusBrief,
  outputSchemaInstruction,
  roleInstruction,
} from "./prompts";

type RunRow = typeof runs.$inferSelect;

/**
 * Simpan pesan run ke conversation + segarkan ringkasan bila melewati ambang.
 * Mengembalikan biaya provider ringkasan (USD) agar dibebankan ke run ini.
 * Tidak pernah melempar (persistensi tak boleh merusak billing).
 */
async function persistConversation(
  runId: string,
  projectId: string,
  conversationId: string | null,
  userContent: string,
  assistantContent: string | null,
): Promise<number> {
  if (!conversationId) return 0;
  try {
    await ensureConversation(projectId, conversationId, userContent);
    await appendRunMessages({
      projectId,
      conversationId,
      runId,
      userContent,
      assistantContent,
    });
    const refreshed = await maybeRefreshSummary(projectId, conversationId);
    return refreshed.costUsd;
  } catch (error) {
    console.warn(
      `[run ${runId}] gagal menyimpan percakapan:`,
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}

export interface ExecuteOptions {
  history?: ChatMessage[];
  summary?: string | null;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  /**
   * Biaya provider yang sudah terjadi di luar step recipe (mis. ringkasan
   * percakapan) namun tetap ditagihkan ke project dengan markup yang sama.
   */
  extraProviderCostUsd?: number;
}

export interface ExecuteResult {
  status: RunRow["status"];
  chargedMicro: number;
  output: unknown;
}

export class StepError extends Error {}

function emit(runId: string, event: RunEvent): void {
  runEvents.emit(runId, event);
}

/** Bangun daftar pesan untuk sebuah step berdasarkan perannya & output step sebelumnya. */
function buildMessages(
  step: RecipeStep,
  recipe: RecipeConfig,
  original: string,
  brief: InterpreterBrief | null,
  priorOutputs: Map<string, InvokeResult["output"]>,
  opts: ExecuteOptions,
): { system: string; messages: ChatMessage[] } {
  const prior = (from?: string): InvokeResult["output"] | undefined =>
    from ? priorOutputs.get(from) : undefined;

  const baseSystem = GATTAI_SYSTEM;
  const withRole = (extra?: string): string =>
    [baseSystem, roleInstruction(step.role), extra].filter(Boolean).join(" ");

  switch (step.role) {
    case "execute": {
      const content = buildOriginalPlusBrief(original, brief);
      const history = opts.history ?? [];
      // Ringkasan percakapan ikut sebagai konteks SISTEM (bukan pesan user)
      // supaya model tidak membacanya sebagai permintaan baru.
      const summaryNote = opts.summary
        ? `Earlier turns in this conversation (summary):\n${opts.summary}`
        : undefined;
      return { system: withRole(summaryNote), messages: [...history, { role: "user", content }] };
    }
    case "gather_sources":
      return { system: withRole(), messages: [{ role: "user", content: original }] };
    case "write_report": {
      const sources = prior(step.input_from);
      const citations = sources?.citations?.length
        ? `\n\nSources:\n${sources.citations.map((c, i) => `[${i + 1}] ${c}`).join("\n")}`
        : "";
      return {
        system: withRole(),
        messages: [
          {
            role: "user",
            content: `Original request:\n${original}\n\nGathered material:\n${sources?.content ?? ""}${citations}`,
          },
        ],
      };
    }
    case "write_code":
      return {
        system: withRole(),
        messages: [{ role: "user", content: buildOriginalPlusBrief(original, brief) }],
      };
    case "review": {
      const code = prior(step.input_from);
      return {
        system: REVIEWER_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Original request:\n${original}\n\nCode to review:\n${code?.content ?? ""}`,
          },
        ],
      };
    }
    case "fix": {
      const review = prior(step.input_from);
      const code = prior("write");
      return {
        system: withRole(),
        messages: [
          {
            role: "user",
            content: `Original request:\n${original}\n\nDraft code:\n${code?.content ?? ""}\n\nReview feedback:\n${review?.content ?? ""}`,
          },
        ],
      };
    }
    case "art_direction":
    case "script_and_shots":
    case "copy_pack": {
      const schemaNote = step.output_schema ? outputSchemaInstruction(step.output_schema) : "";
      return {
        system: withRole(schemaNote),
        messages: [{ role: "user", content: buildOriginalPlusBrief(original, brief) }],
      };
    }
    default:
      return {
        system: withRole(),
        messages: [{ role: "user", content: buildOriginalPlusBrief(original, brief) }],
      };
  }
}

function extractMediaSpec(priorOutput: InvokeResult["output"] | undefined): MediaSpec {
  if (!priorOutput) throw new StepError("Media input is not available from the previous step");
  const raw = priorOutput.data ?? parseJsonFromText(priorOutput.content ?? "");

  // Dukung spec langsung maupun yang dibungkus (mis. launch_kit → { banner: {...} }).
  const candidate =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? ((raw as Record<string, unknown>).banner ??
        (raw as Record<string, unknown>).media ??
        raw)
      : raw;

  const parsed = mediaSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new StepError(`Invalid media spec: ${parsed.error.message}`);
  }
  return parsed.data;
}

interface StepOutcome {
  output: InvokeResult["output"];
  usage: InvokeResult["usage"];
  providerCostUsd: number;
  requestRef: string;
}

/** Jalankan satu step (interpreter, teks, atau media). */
async function runStep(
  recipe: RecipeConfig,
  step: RecipeStep,
  original: string,
  brief: InterpreterBrief | null,
  priorOutputs: Map<string, InvokeResult["output"]>,
  opts: ExecuteOptions,
): Promise<StepOutcome> {
  const model = getModelByRef(step.model_ref);
  const adapter = getAdapter(model.provider);

  if (step.role === "interpret") {
    const result = await runInterpreter({
      modelRef: step.model_ref,
      original,
      summary: opts.summary,
      signal: opts.signal,
      maxTokens: env.maxOutputTokensPerStep,
    });
    return {
      output: { type: "json", content: result.step.output.content, data: result.brief },
      usage: result.step.usage,
      providerCostUsd: result.providerCostUsd,
      requestRef: result.step.requestRef,
    };
  }

  if (model.kind !== "text") {
    const media = extractMediaSpec(
      step.input_from ? priorOutputs.get(step.input_from) : undefined,
    );
    const result = await adapter.invoke({ model, step, messages: [], media, signal: opts.signal });
    return {
      output: result.output,
      usage: result.usage,
      providerCostUsd: result.providerCostUsd,
      requestRef: result.requestRef,
    };
  }

  const { system, messages } = buildMessages(step, recipe, original, brief, priorOutputs, opts);

  if (step.stream && adapter.stream && opts.onDelta) {
    const iterator = adapter.stream({
      model,
      step,
      system,
      messages,
      signal: opts.signal,
      maxTokens: env.maxOutputTokensPerStep,
    });
    let next = await iterator.next();
    while (!next.done) {
      if (next.value.delta) opts.onDelta(next.value.delta);
      next = await iterator.next();
    }
    const result = next.value;
    return {
      output: result.output,
      usage: result.usage,
      providerCostUsd: result.providerCostUsd,
      requestRef: result.requestRef,
    };
  }

  const result = await adapter.invoke({
    model,
    step,
    system,
    messages,
    signal: opts.signal,
    maxTokens: env.maxOutputTokensPerStep,
  });
  const output = { ...result.output };
  if (step.output_schema && typeof output.content === "string") {
    output.data = parseJsonFromText(output.content);
    output.type = "json";
  }
  return {
    output,
    usage: result.usage,
    providerCostUsd: result.providerCostUsd,
    requestRef: result.requestRef,
  };
}

/**
 * Menjalankan seluruh step recipe untuk sebuah run, dengan billing penuh.
 * Dipanggil setelah run berada di status yang siap dieksekusi (RESERVED/ay).
 */
export async function executeRun(runId: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const runRow = (
    await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  )[0];
  if (!runRow) throw new Error(`Run not found: ${runId}`);

  const recipe = getRecipe(runRow.recipeId);
  if (!recipe) throw new Error(`Recipe not found: ${runRow.recipeId}`);

  const markup = resolveMarkup(recipe);
  const estimate = estimateRecipe(recipe);
  const original = runRow.input;
  const priorOutputs = new Map<string, InvokeResult["output"]>();
  let brief: InterpreterBrief | null = null;
  let totalProviderCost = opts.extraProviderCostUsd ?? 0;

  // Konteks percakapan: server menyimpan SELURUH turn di `messages`, sedangkan
  // klien hanya memegang yang sudah dimuat di layarnya (setelah reload atau
  // paginasi, turn lama tidak ada di memori). Karena itu run ber-`conversation_id`
  // memakai konteks dari DB — kecuali pemanggil mengirim `history` eksplisit,
  // yang tetap dihormati demi kompatibilitas v1 (klien API). Ringkasan selalu
  // dari DB: hanya server yang bisa memeliharanya.
  if (runRow.conversationId) {
    const context = await getConversationContext(
      runRow.projectId,
      runRow.conversationId,
      getParams().context.history_window_messages,
    );
    opts = {
      ...opts,
      history: opts.history?.length ? opts.history : context.messages,
      summary: context.summary ?? opts.summary,
    };
  }

  // ── Reservasi ──────────────────────────────────────────────────────────────
  // Run trial dan holder dilewati: tidak ada credit untuk ditahan, dan biaya provider
  // ditanggung kuota gratis platform.
  let reservedMicro = 0;
  if (!runRow.isTrial && !runRow.isHolder) {
    const reserved = await reserve({ projectId: runRow.projectId, runId, amountMicro: estimate.reserveMicro });
    if (!reserved.ok) {
      await db
        .update(runs)
        .set({ status: "INSUFFICIENT_BALANCE", error: "Insufficient credits" })
        .where(
          and(
            eq(runs.id, runId),
            inArray(runs.status, ["CREATED", "RESERVED"]),
          ),
        );
      emit(runId, { type: "status", status: "INSUFFICIENT_BALANCE" });
      emit(runId, { type: "done", status: "INSUFFICIENT_BALANCE" });
      return { status: "INSUFFICIENT_BALANCE", chargedMicro: 0, output: null };
    }
    // Executor lain sudah memegang reservasi run ini (retry/timeout/dua
    // request). Jangan menagih atau melepas reservasi miliknya.
    if (!reserved.applied) {
      console.warn(`[run ${runId}] reservasi sudah dipegang executor lain; eksekusi dilewati`);
      return { status: runRow.status, chargedMicro: 0, output: null };
    }
    reservedMicro = estimate.reserveMicro;
  }

  // Klaim transisi ke RUNNING secara bersyarat. Reaper bisa saja sudah
  // menandai run ini RELEASED tepat sebelum baris ini; jangan menimpa status
  // terminal itu dan jangan meninggalkan reservasi yatim.
  const claimed = await db
    .update(runs)
    .set({ status: "RUNNING", reservedMicro, heartbeatAt: new Date() })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["CREATED", "RESERVED"])))
    .returning({ id: runs.id });

  if (claimed.length === 0) {
    if (reservedMicro > 0) {
      await release({ projectId: runRow.projectId, runId, amountMicro: reservedMicro });
    }
    const current = (
      await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1)
    )[0];
    return { status: current?.status ?? "RELEASED", chargedMicro: 0, output: null };
  }

  emit(runId, { type: "status", status: "RUNNING" });

  // Heartbeat periodik: satu step provider bisa berjalan lebih lama dari
  // `RUN_STALE_AFTER_MS`. Tanpa timer ini, run yang masih hidup bisa di-reap
  // saat menunggu provider. Timer berhenti sendiri bila status bukan RUNNING.
  let runFinished = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      if (runFinished) {
        clearInterval(heartbeat);
        return;
      }
      try {
        const rows = await db
          .update(runs)
          .set({ heartbeatAt: new Date() })
          .where(and(eq(runs.id, runId), eq(runs.status, "RUNNING")))
          .returning({ id: runs.id });
        if (rows.length === 0) clearInterval(heartbeat);
      } catch (error) {
        console.warn(
          `[run ${runId}] gagal memperbarui heartbeat: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    })();
  }, 60_000);
  (heartbeat as { unref?: () => void }).unref?.();

  let lastText: InvokeResult["output"] | null = null;
  let lastStructured: InvokeResult["output"] | null = null;
  let lastMedia: InvokeResult["output"] | null = null;

  try {
    for (const step of recipe.steps) {
      const model = getModelByRef(step.model_ref);
      const stepId = newId("rst");
      // Jantung run: reaper memakai `heartbeat_at`, jadi step yang panjang
      // tidak membuat run yang masih hidup dianggap yatim.
      await db.update(runs).set({ heartbeatAt: new Date() }).where(eq(runs.id, runId));
      emit(runId, { type: "step_pending", stepId: step.id });

      await db.insert(runSteps).values({
        id: stepId,
        runId,
        stepId: step.id,
        provider: step.provider,
        model: model.model,
        role: step.role,
        status: "RUNNING",
      });

      const startedAt = Date.now();
      try {
        const outcome = await runStep(recipe, step, original, brief, priorOutputs, opts);
        const latencyMs = Date.now() - startedAt;
        totalProviderCost += outcome.providerCostUsd;

        if (step.role === "interpret" && outcome.output.data) {
          brief = outcome.output.data as InterpreterBrief;
        }
        priorOutputs.set(step.id, outcome.output);
        if (outcome.output.type === "json") {
          lastStructured = outcome.output;
        } else if (
          outcome.output.type === "image" ||
          outcome.output.type === "video" ||
          outcome.output.type === "audio"
        ) {
          lastMedia = outcome.output;
        } else {
          lastText = outcome.output;
        }

        await db
          .update(runSteps)
          .set({
            status: "COMPLETE",
            inputTokens: outcome.usage.inputTokens ?? null,
            outputTokens: outcome.usage.outputTokens ?? null,
            units: outcome.usage.units != null ? String(outcome.usage.units) : null,
            providerCostUsd: String(outcome.providerCostUsd),
            latencyMs,
            output: outcome.output,
            requestRef: outcome.requestRef,
          })
          .where(eq(runSteps.id, stepId));

        emit(runId, { type: "step_complete", stepId: step.id, providerCostUsd: outcome.providerCostUsd });
      } catch (error) {
        const pub = toPublicRunError(error);
        console.error(
          `[run ${runId}] step ${step.id} gagal (${pub.code}): ${internalErrorDetail(error)}`,
        );
        await db
          .update(runSteps)
          .set({ status: "FAILED", error: pub.message, latencyMs: Date.now() - startedAt })
          .where(eq(runSteps.id, stepId));
        emit(runId, { type: "step_failed", stepId: step.id, error: pub.message });
        throw error;
      }

      // Step ini sudah selesai dan tercatat. Jika biayanya melewati plafon,
      // hentikan run sebelum step berikutnya; jangan tandai step yang sukses
      // sebagai gagal.
      if (totalProviderCost > env.maxProviderCostUsdPerRun) {
        throw new RunLimitReachedError();
      }
    }
  } catch (error) {
    const pub = toPublicRunError(error);
    console.error(`[run ${runId}] run gagal (${pub.code}): ${internalErrorDetail(error)}`);
    // Simpan konteks percakapan (user) sebelum menagih, agar riwayat tetap
    // lengkap walau run gagal. Tidak pernah melempar.
    totalProviderCost += await persistConversation(
      runId,
      runRow.projectId,
      runRow.conversationId,
      original,
      null,
    );
    // Run gagal: tetap tagih step yang sudah benar-benar berbiaya (mis. interpreter
    // atau step teks yang selesai sebelum step berikutnya gagal), lalu lepas sisanya.
    const isFree = runRow.isTrial || runRow.isHolder;
    const chargedMicro = isFree ? 0 : chargeMicroFromProviderCost(totalProviderCost, markup);
    runFinished = true;
    // Settlement ledger + status run dalam satu transaksi. Bila salah satu
    // gagal, keduanya rollback; tidak ada run RELEASED yang ledger-nya belum
    // dilepas, atau sebaliknya.
    await settleRun({
      projectId: runRow.projectId,
      runId,
      reservedMicro,
      chargedMicro,
      finalStatus: "RELEASED",
      error: pub.message,
      providerCostUsd: totalProviderCost,
    });

    clearInterval(heartbeat);
    emit(runId, { type: "done", status: "RELEASED" });
    return { status: "RELEASED", chargedMicro, output: null };
  }

  // ── Percakapan: simpan pesan + segarkan ringkasan; biayanya ikut ditagih.
  const assistantContent =
    lastText && typeof lastText.content === "string" ? lastText.content : null;
  totalProviderCost += await persistConversation(
    runId,
    runRow.projectId,
    runRow.conversationId,
    original,
    assistantContent,
  );

  // ── Settle ─────────────────────────────────────────────────────────────────
  const isFree = runRow.isTrial || runRow.isHolder;
  const chargedMicro = isFree ? 0 : chargeMicroFromProviderCost(totalProviderCost, markup);
  const outputObj = {
    type: recipe.mode,
    content: lastText?.content ?? null,
    data: lastStructured?.data ?? null,
    media: lastMedia ? { type: lastMedia.type, url: lastMedia.url ?? null } : null,
  };

  runFinished = true;
  // Ledger + status SETTLED atomik. `settleRun` juga idempoten, jadi retry
  // setelah timeout tidak menagih dua kali.
  await settleRun({
    projectId: runRow.projectId,
    runId,
    reservedMicro,
    chargedMicro,
    finalStatus: "SETTLED",
    output: outputObj,
    error: null,
    providerCostUsd: totalProviderCost,
  });

  clearInterval(heartbeat);
  emit(runId, { type: "done", status: "SETTLED" });
  return { status: "SETTLED", chargedMicro, output: outputObj };
}
