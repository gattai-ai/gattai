import { getModelByRef, getParams } from "../config";
import { getAdapter, type ChatMessage } from "../providers";

/**
 * Ringkas riwayat percakapan panjang menjadi satu blok konteks.
 *
 * Tujuan: menekan biaya token saat percakapan memanjang. Model murah
 * (`gpt_architect`) meringkas seluruh transkrip; hanya beberapa turn terakhir
 * dipertahankan verbatim agar nuansa terbaru tetap utuh. Ringkasan lalu
 * diteruskan ke interpreter sebagai konteks (bukan instruksi).
 *
 * Biaya panggilan ringkasan dibebankan ke run (lihat `extraProviderCostUsd`).
 */

const SUMMARY_MODEL_REF = "gpt_architect";
/**
 * Jumlah pesan terakhir yang dipertahankan verbatim: tidak ikut diringkas ke
 * dalam teks ringkasan, dan tidak ikut dipangkas dari tabel `messages`.
 */
export const KEEP_RECENT_MESSAGES = 2;

const SUMMARY_SYSTEM = [
  "You compress a conversation into a concise context summary.",
  "Preserve facts, decisions, constraints, names, numbers, code identifiers, and open questions.",
  "Do not add opinions or new information. Output plain text only, no preamble.",
].join(" ");

export interface SummaryResult {
  /** Ringkasan, atau null bila riwayat pendek / ringkasan kosong. */
  summary: string | null;
  /** Riwayat yang dipakai untuk run (dipotong bila diringkas). */
  history: ChatMessage[];
  /** Biaya provider dari panggilan ringkasan (USD). */
  providerCostUsd: number;
  summarized: boolean;
}

function totalChars(history: ChatMessage[]): number {
  return history.reduce((acc, message) => acc + message.content.length, 0);
}

export async function summarizeHistory(
  history: ChatMessage[],
  opts: { signal?: AbortSignal; thresholdChars?: number } = {},
): Promise<SummaryResult> {
  const threshold = opts.thresholdChars ?? getParams().context.summary_threshold_chars;
  if (history.length <= KEEP_RECENT_MESSAGES || totalChars(history) <= threshold) {
    return { summary: null, history, providerCostUsd: 0, summarized: false };
  }

  const model = getModelByRef(SUMMARY_MODEL_REF);
  const adapter = getAdapter(model.provider);
  const transcript = history
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");

  const result = await adapter.invoke({
    model,
    step: {
      id: "summarize",
      provider: model.provider,
      model_ref: SUMMARY_MODEL_REF,
      role: "summarize",
      // Metadata internal; tidak pernah tampil di UI.
      label: "Summarizer",
      role_label: "summarize",
    },
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user", content: transcript }],
    signal: opts.signal,
  });

  const summary = (result.output.content ?? "").trim();
  return {
    summary: summary || null,
    history: history.slice(-KEEP_RECENT_MESSAGES),
    providerCostUsd: result.providerCostUsd,
    summarized: summary.length > 0,
  };
}
