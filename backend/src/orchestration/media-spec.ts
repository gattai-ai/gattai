import { z } from "zod";

/**
 * Spec media (output Claude pada recipe visual/video). Divalidasi terhadap
 * batas model sebelum dikirim ke Higgsfield.
 */

export const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;

export const mediaSpecSchema = z.object({
  model_hint: z.string().optional(),
  prompt: z.string().min(1, "prompt is required"),
  negative_prompt: z.string().optional(),
  aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
  duration_s: z.number().min(1).max(30).optional(),
  audio: z.boolean().optional(),
  shots: z.array(z.object({ t: z.number().nonnegative(), desc: z.string() })).optional(),
});

export type MediaSpecOutput = z.infer<typeof mediaSpecSchema>;

/** Ambil objek JSON dari teks (bisa dibungkus code fence). */
export function parseJsonFromText<T = unknown>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(slice) as T;
}
