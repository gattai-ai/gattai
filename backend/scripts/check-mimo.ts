import "dotenv/config";
import { getModelByRef } from "../src/config";
import { env, getProviderApiKey } from "../src/env";

/**
 * Smoke check MIMO Token Plan.
 *
 * Region melekat pada base URL (CN vs SGP): key dari satu region akan dibalas
 * 401 oleh region lain. Script ini menguji jalur non-stream (interpreter) dan
 * stream (executor) dengan prompt sangat pendek sebelum deploy.
 *
 * Jalankan dari folder backend:
 *   bun run mimo:check
 * atau dari root:
 *   bun run --cwd backend mimo:check
 */

const TIMEOUT_MS = 30_000;

function endpoint(): string {
  return `${env.mimoApiUrl.replace(/\/$/, "")}/chat/completions`;
}

function model(): string {
  return getModelByRef("mimo_primary").model || env.mimoModel;
}

async function post(stream: boolean): Promise<{ ok: boolean; status: number; detail: string }> {
  const key = getProviderApiKey("mimo");
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": key },
    body: JSON.stringify({
      model: model(),
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_completion_tokens: 16,
      thinking: { type: "disabled" },
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  return {
    ok: response.ok && (!stream || body.includes("data:")),
    status: response.status,
    detail: body.slice(0, 300).replace(/\s+/g, " "),
  };
}

async function main(): Promise<void> {
  console.log(`MIMO endpoint: ${env.mimoApiUrl}`);
  console.log(`MIMO model:    ${model()}`);

  let failed = false;
  for (const stream of [false, true]) {
    const label = stream ? "stream" : "non-stream";
    try {
      const result = await post(stream);
      console.log(`[${label}] status=${result.status} ok=${result.ok} body=${result.detail}`);
      if (!result.ok) failed = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${label}] error=${message}`);
      failed = true;
    }
  }

  if (failed) {
    console.error(
      "MIMO check FAILED. Pastikan MIMO_API_URL cocok dengan region MIMO_API_KEY (CN vs SGP).",
    );
    process.exitCode = 1;
    return;
  }
  console.log("MIMO check OK.");
}

await main();
