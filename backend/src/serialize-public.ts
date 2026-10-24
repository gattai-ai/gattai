import { getRecipe } from "./config";
import type { RunShareRow, RunStepRow, SharedRun } from "./services/shares";
import { microToCreditsString, microToUsdString } from "./lib/money";

/**
 * Serializer khusus halaman publik `/run/:slug`.
 *
 * Jangan digabung dengan `serializeRun()`: serializer internal mengirim run id,
 * prompt penuh, biaya provider, id step, dan data operasional lain. Bentuk di
 * sini adalah kontrak publik yang sengaja sempit dan stabil.
 */

const PUBLIC_PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Claude",
  openai: "GPT",
  perplexity: "Perplexity",
  higgsfield: "Higgsfield",
  mimo: "Model",
};

const SUMMARY_MAX = 320;

function publicRoleSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function summaryFromOutput(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const record = output as Record<string, unknown>;
  const content = record.content;
  if (typeof content !== "string") return null;
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > SUMMARY_MAX ? `${collapsed.slice(0, SUMMARY_MAX - 1)}…` : collapsed;
}

/** Hanya media https yang boleh tampil di halaman publik. */
function publicMedia(output: unknown): { type: string; url: string } | null {
  if (typeof output !== "object" || output === null) return null;
  const media = (output as Record<string, unknown>).media;
  if (typeof media !== "object" || media === null) return null;
  const record = media as Record<string, unknown>;
  const url = record.url;
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return null;
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  const type =
    record.type === "video" || record.type === "audio" || record.type === "image"
      ? record.type
      : "image";
  return { type, url };
}

function publicStep(
  step: RunStepRow,
  configStep:
    | {
        label: string;
        role: string;
        role_label: string;
        public_role?: string;
      }
    | undefined,
) {
  const roleLabel = configStep?.public_role ?? configStep?.role_label ?? step.role;
  return {
    // Slug publik stabil; role internal (`write_report`, dst.) tidak dikirim.
    role: publicRoleSlug(roleLabel),
    role_label: roleLabel,
    provider: configStep?.label ?? PUBLIC_PROVIDER_NAMES[step.provider] ?? "Model",
    status: step.status,
    summary: summaryFromOutput(step.output),
    duration_ms: step.latencyMs,
  };
}

export interface PublicRunOptions {
  mediaShareEnabled: boolean;
}

export function serializePublicRun(
  shared: SharedRun,
  options: PublicRunOptions,
) {
  const { share, run, steps } = shared;
  const recipe = getRecipe(run.recipeId);
  const output =
    typeof run.output === "object" && run.output !== null
      ? (run.output as Record<string, unknown>)
      : {};
  const content = typeof output.content === "string" ? output.content : null;
  const media = options.mediaShareEnabled ? publicMedia(output) : null;

  return {
    slug: share.slug,
    formation: {
      id: run.recipeId,
      name: recipe?.name ?? run.recipeId,
      mode: run.mode,
    },
    prompt: share.showPrompt ? run.input : null,
    output: {
      type: typeof output.type === "string" ? output.type : run.mode,
      content,
      media,
    },
    steps: steps.map((step) =>
      publicStep(step, recipe?.steps.find((candidate) => candidate.id === step.stepId)),
    ),
    cost: {
      credits: microToCreditsString(run.chargedMicro),
      usd: microToUsdString(run.chargedMicro),
    },
    created_at: run.createdAt,
    finished_at: run.finishedAt,
  };
}

/** Bentuk share yang aman untuk response pemilik (tanpa run/project id). */
export function serializeShare(share: RunShareRow, baseUrl: string) {
  return {
    slug: share.slug,
    url: `${baseUrl.replace(/\/+$/, "")}/run/${share.slug}`,
    show_prompt: share.showPrompt,
    created_at: share.createdAt,
  };
}
