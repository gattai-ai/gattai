import { env, getProviderApiKey } from "../env";
import { providerError, providerFailure } from "../lib/public-error";
import { fetchWithRetry } from "./http";
import {
  computeProviderCost,
  type InvokeInput,
  type InvokeResult,
  type MediaSpec,
  type ProviderAdapter,
  type ProviderOutput,
} from "./types";

/**
 * Higgsfield — lapisan media (gambar/video/audio), antrean asinkron.
 *
 * PERINGATAN: API Higgsfield masih baru (Sep 2026). Bentuk endpoint di bawah
 * dibuat generik dan bisa diganti lewat env tanpa mengubah kode pemanggil:
 *   - HIGGSFIELD_API_URL  (base URL)
 *   - HIGGSFIELD_SUBMIT_PATH  (default /v1/generations)
 *   - HIGGSFIELD_STATUS_PATH  (default /v1/generations/{id})
 * Verifikasi katalog model, rate limit, dan webhook sebelum produksi.
 */

const SUBMIT_PATH = process.env.HIGGSFIELD_SUBMIT_PATH ?? "/v1/generations";
const STATUS_PATH = process.env.HIGGSFIELD_STATUS_PATH ?? "/v1/generations/{id}";
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 100;

interface JobResponse {
  id?: string;
  request_id?: string;
  status?: string;
  output?: string[];
  url?: string;
  output_url?: string;
  error?: string;
}

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${getProviderApiKey("higgsfield")}`,
  };
}

function outputType(kind: string): ProviderOutput["type"] {
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  return "image";
}

function buildPayload(input: InvokeInput, spec: MediaSpec) {
  return {
    model: input.model.model,
    prompt: spec.prompt,
    negative_prompt: spec.negative_prompt,
    aspect_ratio: spec.aspect_ratio,
    duration: spec.duration_s,
    audio: spec.audio,
  };
}

function isTerminal(status: string | undefined): boolean {
  return status === "completed" || status === "succeeded" || status === "failed" || status === "error";
}

async function pollJob(jobId: string, signal?: AbortSignal): Promise<JobResponse> {
  const url = `${env.higgsfieldApiUrl}${STATUS_PATH.replace("{id}", jobId)}`;
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    const response = await fetchWithRetry(
      url,
      { headers: headers() },
      { label: "Higgsfield", signal, attempts: 3, timeoutMs: 30_000 },
    );
    if (!response.ok) {
      throw providerError("higgsfield", response.status, await response.text());
    }
    const job = (await response.json()) as JobResponse;
    if (isTerminal(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw providerFailure("higgsfield", `job ${jobId} timed out while polling`);
}

async function invoke(input: InvokeInput): Promise<InvokeResult> {
  if (!input.media) {
    throw new Error("Higgsfield requires a media spec from the previous step");
  }

  const submitUrl = `${env.higgsfieldApiUrl}${SUBMIT_PATH}`;
  const submitResponse = await fetchWithRetry(
    submitUrl,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(buildPayload(input, input.media)),
    },
    { label: "Higgsfield", signal: input.signal },
  );

  if (!submitResponse.ok) {
    throw providerError("higgsfield", submitResponse.status, await submitResponse.text());
  }

  const submitted = (await submitResponse.json()) as JobResponse;
  const jobId = submitted.id ?? submitted.request_id;
  if (!jobId) {
    throw providerFailure("higgsfield", "submit response did not include a job id");
  }

  // Job bisa langsung selesai (sinkron) atau perlu polling.
  const job = isTerminal(submitted.status) ? submitted : await pollJob(jobId, input.signal);

  if (job.status === "failed" || job.status === "error") {
    // Request gagal tidak ditagih.
    throw providerFailure("higgsfield", `job failed: ${job.error ?? "unknown error"}`);
  }

  const url = job.output_url ?? job.url ?? job.output?.[0];
  const usage = { units: 1 };

  return {
    output: { type: outputType(input.model.kind), url, data: job },
    usage,
    providerCostUsd: computeProviderCost(input.model, usage),
    requestRef: jobId,
  };
}

export const higgsfieldAdapter: ProviderAdapter = {
  name: "higgsfield",
  invoke,
};
