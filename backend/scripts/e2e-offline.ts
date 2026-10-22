/**
 * E2E offline: menjalankan seluruh pipeline GATTAI (HTTP → auth → interpreter →
 * orchestrator → provider → billing → ledger) tanpa API key asli, dengan
 * mengarahkan provider ke mock server lokal.
 *
 * Prasyarat: DATABASE_URL valid (migrasi sudah dijalankan).
 *
 * Jalankan:
 *   bun run e2e:offline
 */

import "dotenv/config";

const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4319);
const MOCK_ORIGIN = `http://localhost:${MOCK_PORT}`;

// Arahkan provider ke mock + pastikan key tidak kosong SEBELUM modul src dimuat.
process.env.ANTHROPIC_API_URL = MOCK_ORIGIN;
process.env.OPENAI_API_URL = MOCK_ORIGIN;
process.env.PERPLEXITY_API_URL = MOCK_ORIGIN;
process.env.MIMO_API_URL = MOCK_ORIGIN;
process.env.ANTHROPIC_API_KEY ||= "mock-anthropic";
process.env.OPENAI_API_KEY ||= "mock-openai";
process.env.PERPLEXITY_API_KEY ||= "mock-perplexity";
process.env.MIMO_API_KEY ||= "mock-mimo";
process.env.PROVIDER_RETRY_ATTEMPTS ||= "2";
process.env.PROVIDER_TIMEOUT_MS ||= "5000";

import { startMockProviders } from "./mock-providers";

import type app from "../src/app";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}`, detail ?? "");
  }
}

async function main(): Promise<void> {
  const mock = startMockProviders(MOCK_PORT);

  const { default: appModule } = (await import("../src/app")) as { default: typeof app };
  const { db, pool } = await import("../src/db");
  const { projects, apiKeys } = await import("../src/db/schema");
  const { generateApiKey, hashSecret } = await import("../src/lib/crypto");
  const { newId } = await import("../src/lib/id");
  const { recordCreditLot, getBalanceMicro } = await import("../src/billing/ledger");
  const { creditsToMicro, microToCredits } = await import("../src/lib/money");
  const { syncRecipes } = await import("../src/orchestration/create-run");

  const projectId = newId("prj");
  await db.insert(projects).values({
    id: projectId,
    name: "e2e-offline",
    // Diturunkan dari id unik, bukan wallet tetap: `owner_wallet` punya unique
    // index dan skrip ini tidak (dan tidak perlu) menghapus project-nya, jadi
    // wallet tetap akan menabrak run berikutnya.
    ownerWallet: `0x${projectId.slice(-40).padStart(40, "0")}`,
  });
  const { secret, prefix } = generateApiKey();
  await db.insert(apiKeys).values({
    id: newId("key"),
    projectId,
    prefix,
    hash: hashSecret(secret),
    label: "e2e",
  });
  await syncRecipes();
  await recordCreditLot({
    projectId,
    source: "PROMO",
    amountMicro: creditsToMicro(100),
    idempotencyKey: `e2e:${projectId}`,
  });

  const auth = { authorization: `Bearer ${secret}`, "content-type": "application/json" };

  console.log("\n1) /v1/balance");
  const balanceRes = await appModule.request("/v1/balance", { headers: auth });
  const balance = (await balanceRes.json()) as { balance_credits: number };
  check("balance awal 100 credits", Math.round(balance.balance_credits) === 100, balance);

  for (const model of ["gattai/refine", "gattai/research", "gattai/code"]) {
    console.log(`\n2) chat/completions (non-stream) → ${model}`);
    const res = await appModule.request("/v1/chat/completions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Halo, ini uji E2E." }],
        stream: false,
      }),
    });
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      gattai?: { status?: string };
    };
    check(`${model} → 200`, res.status === 200, res.status);
    check(`${model} → status SETTLED`, body.gattai?.status === "SETTLED", body.gattai);
    check(
      `${model} → konten tidak kosong`,
      typeof body.choices?.[0]?.message?.content === "string" &&
        (body.choices[0].message.content ?? "").length > 0,
    );
  }

  console.log("\n3) chat/completions (stream) → gattai/refine");
  const streamRes = await appModule.request("/v1/chat/completions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      model: "gattai/refine",
      messages: [{ role: "user", content: "Stream dong." }],
      stream: true,
    }),
  });
  const streamText = await streamRes.text();
  check("stream → 200", streamRes.status === 200, streamRes.status);
  check("stream → ada chunk SSE", streamText.includes("chat.completion.chunk"));
  check("stream → ada [DONE]", streamText.includes("[DONE]"));

  console.log("\n4) jalur gagal: provider MIMO mati → tagih step yang sudah berbiaya");
  const goodBase = process.env.MIMO_API_URL;
  process.env.MIMO_API_URL = "http://127.0.0.1:9"; // port mati
  const failRes = await appModule.request("/v1/chat/completions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      model: "gattai/refine",
      messages: [{ role: "user", content: "Ini akan gagal di step execute." }],
      stream: false,
    }),
  });
  const failBody = (await failRes.json()) as { gattai?: { status?: string; run_id?: string } };
  process.env.MIMO_API_URL = goodBase;

  check("run gagal → 200 (status RELEASED)", failRes.status === 200, failRes.status);
  check("run gagal → status RELEASED", failBody.gattai?.status === "RELEASED", failBody.gattai);

  const runId = failBody.gattai?.run_id;
  if (runId) {
    const runRes = await appModule.request(`/v1/runs/${runId}`, { headers: auth });
    const run = (await runRes.json()) as { status?: string };
    // Single-provider (MIMO): interpreter ikut mati → fallback pass-through
    // lalu executor gagal → RELEASED. Tagihan parsial diuji di unit test
    // ("jalur gagal" di test/e2e.test.ts via mimoFailExecuteOnly).
    check("run gagal → status RELEASED di detail", run.status === "RELEASED", run.status);
  }

  console.log("\n5) /v1/usage");
  const usageRes = await appModule.request("/v1/usage", { headers: auth });
  const usage = (await usageRes.json()) as { entries?: unknown[] };
  check("usage memiliki entri ledger", Array.isArray(usage.entries) && usage.entries.length > 0);

  const finalMicro = await getBalanceMicro(projectId);
  console.log(`\nSaldo akhir: ${microToCredits(finalMicro)} credits`);

  mock.stop();
  await pool.end();

  console.log(failures === 0 ? "\nE2E OFFLINE: LULUS\n" : `\nE2E OFFLINE: ${failures} GAGAL\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("E2E offline error:", error);
  process.exit(1);
});
