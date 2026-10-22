import { z } from "zod";
import { getModelByRef } from "../config";
import { getAdapter, type InvokeResult } from "../providers";
import { parseJsonFromText } from "./media-spec";
import { INTERPRETER_SYSTEM } from "./prompts";

/** Key brief yang seharusnya string. */
const STRING_KEYS = new Set(["goal", "deliverable", "style"]);
/** Key brief yang seharusnya array of strings. */
const ARRAY_KEYS = new Set([
  "context",
  "constraints",
  "preserve_verbatim",
  "assumptions",
  "open_questions",
  "success_criteria",
]);

/**
 * Normalisasi hasil parser JSON MIMO per-field.
 * - null/undefined → dihapus (Zod `.nullish()` menerima undefined).
 * - String di slot array → dibungkus jadi [string].
 * - Object/number di slot string → JSON.stringify.
 * - Array berisi non-string → filter hanya string.
 */
function normalizeBrief(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined || typeof raw !== "object") return { pass_through: true };
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;

    if (key === "pass_through") {
      out[key] = Boolean(value);
      continue;
    }

    if (STRING_KEYS.has(key)) {
      if (typeof value === "string") {
        if (value.trim()) out[key] = value;
      } else {
        out[key] = JSON.stringify(value);
      }
      continue;
    }

    if (ARRAY_KEYS.has(key)) {
      if (Array.isArray(value)) {
        const filtered = value.filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0,
        );
        if (filtered.length > 0) out[key] = filtered;
      } else if (typeof value === "string" && value.trim()) {
        out[key] = [value];
      }
      continue;
    }
  }

  if (!("pass_through" in out)) out.pass_through = true;
  return out;
}

/** Bentuk brief dari step interpreter (lihat brief developer §5.1). */
export const briefSchema = z.object({
  pass_through: z.boolean(),
  goal: z.string().nullish(),
  deliverable: z.string().nullish(),
  context: z.array(z.string()).nullish(),
  constraints: z.array(z.string()).nullish(),
  preserve_verbatim: z.array(z.string()).nullish(),
  assumptions: z.array(z.string()).nullish(),
  open_questions: z.array(z.string()).nullish(),
  style: z.string().nullish(),
  success_criteria: z.array(z.string()).nullish(),
});

export type InterpreterBrief = z.infer<typeof briefSchema>;

export interface InterpreterResult {
  brief: InterpreterBrief;
  /** True jika interpreter gagal dan fallback ke pass-through dipakai. */
  fellBack: boolean;
  providerCostUsd: number;
  step: InvokeResult;
}

const MAX_ATTEMPTS = 2;
const PASS_THROUGH: InterpreterBrief = { pass_through: true };

function buildUserContent(original: string, summary?: string | null): string {
  if (summary && summary.trim()) {
    return `Conversation summary (for context only):\n${summary}\n\nLatest user message:\n${original}`;
  }
  return original;
}

/**
 * Menjalankan interpreter. Validasi gagal → coba ulang satu kali → fallback
 * ke pass-through (dengan flag di log). Tidak pernah melempar error.
 */
export async function runInterpreter(input: {
  modelRef: string;
  original: string;
  summary?: string | null;
  signal?: AbortSignal;
  maxTokens?: number;
}): Promise<InterpreterResult> {
  const model = getModelByRef(input.modelRef);
  const adapter = getAdapter(model.provider);
  const messages = [
    { role: "system" as const, content: INTERPRETER_SYSTEM },
    { role: "user" as const, content: buildUserContent(input.original, input.summary) },
  ];

  let totalCost = 0;
  let last: InvokeResult | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await adapter.invoke({
        model,
        step: {
          id: "interpret",
          provider: model.provider,
          model_ref: input.modelRef,
          role: "interpret",
          // Metadata internal; label tampilan diambil dari config recipe.
          label: "Interpreter",
          role_label: "interpret",
        },
        messages,
        json: true,
        signal: input.signal,
        maxTokens: input.maxTokens,
      });
      totalCost += result.providerCostUsd;
      last = result;

      const parsed = briefSchema.safeParse(
        normalizeBrief(parseJsonFromText(result.output.content ?? "")),
      );
      if (parsed.success) {
        return { brief: parsed.data, fellBack: false, providerCostUsd: totalCost, step: result };
      }
      console.warn(
        `[interpreter] validasi brief gagal (percobaan ${attempt + 1}): ${parsed.error.message}`,
      );
    } catch (error) {
      console.warn(`[interpreter] panggilan gagal (percobaan ${attempt + 1}):`, error);
    }
  }

  console.warn("[interpreter] fallback ke pass-through");
  return {
    brief: PASS_THROUGH,
    fellBack: true,
    providerCostUsd: totalCost,
    step:
      last ?? {
        output: { type: "json", content: "{}" },
        usage: {},
        providerCostUsd: 0,
        requestRef: "interpreter-fallback",
      },
  };
}
