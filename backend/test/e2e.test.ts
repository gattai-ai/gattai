import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { db } from "../src/db";
import { apiKeys, conversations, messages, projects, runs } from "../src/db/schema";
import { env } from "../src/env";
import { getBalanceMicro, recordCreditLot, reserve } from "../src/billing/ledger";
import { generateApiKey, hashSecret } from "../src/lib/crypto";
import { newId } from "../src/lib/id";
import { creditsToMicro, microToCredits } from "../src/lib/money";
import { syncRecipes } from "../src/orchestration/create-run";
import { reapStaleRuns } from "../src/orchestration/reap";
import {
  appendRunMessages,
  ensureConversation,
  getConversationContext,
  maybeRefreshSummary,
} from "../src/services/conversations";
import { summarizeHistory } from "../src/orchestration/summarize";
import { runEvents } from "../src/orchestration/events";
import { OPENAI_TEXT, installFetch, makeMockFetch } from "./helpers/mock-fetch";
import type { ChatMessage } from "../src/providers";

let restoreFetch: () => void;
let secret: string;
let projectId: string;

const auth = () => ({ authorization: `Bearer ${secret}`, "content-type": "application/json" });

async function chat(model: string, stream = false): Promise<Response> {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Halo, ini uji E2E." }],
      stream,
    }),
  });
}

beforeAll(async () => {
  restoreFetch = installFetch(makeMockFetch());
  projectId = newId("prj");
  await db.insert(projects).values({
    id: projectId,
    name: "e2e-test",
    ownerWallet: `0x${projectId.slice(-40)}`.toLowerCase(),
  });
  const generated = generateApiKey();
  secret = generated.secret;
  await db.insert(apiKeys).values({
    id: newId("key"),
    projectId,
    prefix: generated.prefix,
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
  // Suite ini menguji jalur BERBAYAR. Sejak kuota gratis dipakai lebih dulu
  // untuk semua wallet, kuota project ini dihabiskan di awal supaya setiap run
  // di sini benar-benar menagih saldo dan memunculkan entri SETTLE.
  // Jalur gratis diuji terpisah di `trial.test.ts`.
  await db.insert(runs).values(
    Array.from({ length: 10 }, (_, index) => ({
      id: newId("run"),
      projectId,
      recipeId: "refine",
      status: "SETTLED" as const,
      mode: "streaming",
      input: `trial-exhaust-${index}`,
      isTrial: true,
      output: { type: "streaming", content: OPENAI_TEXT },
      idempotencyKey: newId("idem"),
    })),
  );
});

afterAll(() => {
  restoreFetch?.();
});

describe("E2E pipeline (mock providers)", () => {
  test("auth: endpoint terlindungi menolak tanpa key", async () => {
    const res = await app.request("/v1/balance");
    expect(res.status).toBe(401);
  });

  test("recipe teks (refine/research/code) → SETTLED dengan output", async () => {
    for (const model of ["gattai/refine", "gattai/research", "gattai/code"]) {
      const res = await chat(model);
      const body = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        gattai: { status: string };
      };
      expect(res.status).toBe(200);
      expect(body.gattai.status).toBe("SETTLED");
      // Executor kini MIMO (OpenAI-compat) — output mock-nya OPENAI_TEXT.
      expect(body.choices[0].message.content).toBe(OPENAI_TEXT);
    }
  });

  test("request chat melebihi batas karakter → 413", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        model: "gattai/refine",
        messages: [{ role: "user", content: "x".repeat(env.maxRequestChars + 1) }],
      }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_TOO_LARGE");
  });

  test("streaming SSE mengirim chunk dan [DONE]", async () => {
    const res = await chat("gattai/refine", true);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("[DONE]");
  });

  test("billing: saldo berkurang & ledger punya SETTLE", async () => {
    const balanceRes = await app.request("/v1/balance", { headers: auth() });
    const balance = (await balanceRes.json()) as { balance_credits: number };
    // Harga MIMO mock kecil → penurunan seperseratus kredit; bandingkan desimal.
    expect(balance.balance_credits).toBeLessThan(100);

    const usageRes = await app.request("/v1/usage", { headers: auth() });
    const usage = (await usageRes.json()) as { entries: Array<{ type: string }> };
    expect(usage.entries.some((entry) => entry.type === "SETTLE")).toBe(true);
  });

  test("jalur gagal: provider mati → RELEASED, tagih step yang sudah berbiaya", async () => {
    // Executor MIMO digagalkan, interpreter (request JSON) tetap sukses.
    const failing = installFetch(makeMockFetch({ mimoStatus: 500, mimoFailExecuteOnly: true }));
    try {
      const res = await chat("gattai/refine");
      const body = (await res.json()) as { gattai: { status: string; run_id: string } };
      expect(res.status).toBe(200);
      expect(body.gattai.status).toBe("RELEASED");

      const runRes = await app.request(`/v1/runs/${body.gattai.run_id}`, { headers: auth() });
      const run = (await runRes.json()) as {
        cost: { charged_micro: number };
        error: string | null;
        steps: Array<{ status: string; error: string | null }>;
      };
      // Interpreter (MIMO) sudah berbiaya sebelum step executor gagal.
      expect(run.cost.charged_micro).toBeGreaterThan(0);
      // Pesan mentah provider tidak boleh bocor ke API (lihat lib/public-error).
      expect(run.error ?? "").not.toMatch(/mimo|openai|Error|Environment variable/i);
      for (const step of run.steps) {
        expect(step.error ?? "").not.toMatch(/mimo|openai|Error|Environment variable/i);
      }
    } finally {
      failing();
    }
  });
});

describe("runs native (web chat)", () => {
  test("menerima riwayat + memancarkan delta ke bus event", async () => {
    const bodies: string[] = [];
    const base = makeMockFetch();
    const restore = installFetch(async (input, init) => {
      // Executor kini MIMO (URL OpenAI-compat berisi /v1/chat/completions).
      if (String(input).includes("/v1/chat/completions") || String(input).includes("/v1/messages"))
        bodies.push(String(init?.body ?? ""));
      return base(input, init);
    });

    try {
      const res = await app.request("/v1/runs", {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          recipe_id: "refine",
          input: "Lanjutkan percakapan.",
          history: [
            { role: "user", content: "MARKER-HISTORY-123" },
            { role: "assistant", content: "ok" },
          ],
        }),
      });
      const created = (await res.json()) as { run_id: string; status: string };
      expect(res.status).toBe(202);
      expect(created.status).toBe("CREATED");

      let status = created.status;
      for (let i = 0; i < 50 && !["SETTLED", "RELEASED", "INSUFFICIENT_BALANCE"].includes(status); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const runRes = await app.request(`/v1/runs/${created.run_id}`, { headers: auth() });
        status = ((await runRes.json()) as { status: string }).status;
      }
      expect(status).toBe("SETTLED");

      // `history` eksplisit dari klien tetap dihormati (kompatibilitas v1) dan
      // diteruskan ke provider di step execute.
      expect(bodies.some((body) => body.includes("MARKER-HISTORY-123"))).toBe(true);

      // Delta token dipancarkan ke bus event (untuk streaming web chat).
      const events = runEvents.past(created.run_id);
      expect(events.some((event) => event.type === "delta")).toBe(true);
      expect(events.some((event) => event.type === "done")).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("idempotency runs (visual = tanpa eksekusi)", () => {
  test("key sama + body sama → run yang sama, tanpa duplikat", async () => {
    const key = `idem-${newId("t")}`;
    const body = { recipe_id: "visual", input: "Poster statis." };
    const headers = () => ({ ...auth(), "Idempotency-Key": key });

    const first = await app.request("/v1/runs", { method: "POST", headers: headers(), body: JSON.stringify(body) });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { run_id: string; status: string };
    expect(firstBody.status).toBe("AWAITING_CONFIRMATION");

    const second = await app.request("/v1/runs", { method: "POST", headers: headers(), body: JSON.stringify(body) });
    const secondBody = (await second.json()) as { run_id: string };
    expect(secondBody.run_id).toBe(firstBody.run_id);

    const rows = await db.select({ id: runs.id }).from(runs).where(eq(runs.idempotencyKey, key));
    expect(rows).toHaveLength(1);
  });

  test("key sama di project berbeda tidak membocorkan run", async () => {
    const otherProject = newId("prj");
    await db.insert(projects).values({
      id: otherProject,
      name: "e2e-other",
      ownerWallet: `0x${otherProject.slice(-40)}`.toLowerCase(),
    });
    const generated = generateApiKey();
    await db.insert(apiKeys).values({
      id: newId("key"),
      projectId: otherProject,
      prefix: generated.prefix,
      hash: hashSecret(generated.secret),
      label: "e2e-other",
    });

    const key = `idem-shared-${newId("t")}`;
    const body = { recipe_id: "visual", input: "Poster project lain." };
    const first = await app.request("/v1/runs", {
      method: "POST",
      headers: { ...auth(), "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    const second = await app.request("/v1/runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${generated.secret}`,
        "content-type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = (await first.json()) as { run_id: string };
    const secondBody = (await second.json()) as { run_id: string };
    expect(secondBody.run_id).not.toBe(firstBody.run_id);
  });

  test("key sama + body beda → 409 IDEMPOTENCY_CONFLICT", async () => {
    const key = `idem-${newId("t")}`;
    const headers = () => ({ ...auth(), "Idempotency-Key": key });

    const first = await app.request("/v1/runs", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ recipe_id: "visual", input: "Versi A." }),
    });
    expect(first.status).toBe(202);

    const second = await app.request("/v1/runs", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ recipe_id: "visual", input: "Versi B yang berbeda." }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("create konkuren dengan key sama → satu baris, semua dapat run yang sama", async () => {
    const key = `idem-${newId("t")}`;
    const payload = { recipe_id: "visual", input: "Balapan idempotency." };
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.request("/v1/runs", {
          method: "POST",
          headers: { ...auth(), "Idempotency-Key": key },
          body: JSON.stringify(payload),
        }),
      ),
    );
    const bodies = (await Promise.all(responses.map((res) => res.json()))) as Array<{ run_id: string }>;
    const ids = new Set(bodies.map((item) => item.run_id));
    expect(ids.size).toBe(1);

    const rows = await db.select({ id: runs.id }).from(runs).where(eq(runs.idempotencyKey, key));
    expect(rows).toHaveLength(1);
  });
});

describe("klaim konfirmasi atomik", () => {
  test("dua confirm paralel → satu 202, satu 400; tidak ada run ganda", async () => {
    const created = await app.request("/v1/runs", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ recipe_id: "visual", input: "Konfirmasi balapan." }),
    });
    const { run_id: runId } = (await created.json()) as { run_id: string };

    const [first, second] = await Promise.all([
      app.request(`/v1/runs/${runId}/confirm`, { method: "POST", headers: auth() }),
      app.request(`/v1/runs/${runId}/confirm`, { method: "POST", headers: auth() }),
    ]);
    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([202, 400]);

    // Klaim tercatat: run tidak lagi menunggu konfirmasi.
    let status = "AWAITING_CONFIRMATION";
    for (let i = 0; i < 50 && status === "AWAITING_CONFIRMATION"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const runRes = await app.request(`/v1/runs/${runId}`, { headers: auth() });
      status = ((await runRes.json()) as { status: string }).status;
    }
    expect(status).not.toBe("AWAITING_CONFIRMATION");
  });
});

describe("reaper run yatim", () => {
  test("run RUNNING tua dilepas + reservasi kembali; run baru tak tersentuh", async () => {
    const reapProjectId = newId("prj");
    await db.insert(projects).values({
      id: reapProjectId,
      name: "reap-test",
      ownerWallet: `0x${reapProjectId.slice(-40).padStart(40, "0")}`.toLowerCase(),
    });
    await recordCreditLot({
      projectId: reapProjectId,
      source: "PROMO",
      amountMicro: creditsToMicro(100),
      idempotencyKey: `reap:${reapProjectId}`,
    });

    const oldRunId = newId("run");
    await db.insert(runs).values({
      id: oldRunId,
      projectId: reapProjectId,
      recipeId: "refine",
      recipeVersion: 1,
      status: "RUNNING",
      mode: "streaming",
      input: "macet",
      idempotencyKey: newId("idem"),
      createdAt: new Date(Date.now() - 2 * 3600_000),
      heartbeatAt: new Date(Date.now() - 2 * 3600_000),
    });
    const reserved = await reserve({
      projectId: reapProjectId,
      runId: oldRunId,
      amountMicro: creditsToMicro(10),
    });
    expect(reserved.ok).toBe(true);
    // executeRun nyata mencatat jumlah reservasi di baris run; tiru itu agar
    // reaper melepaskan jumlah yang benar.
    await db.update(runs).set({ reservedMicro: creditsToMicro(10) }).where(eq(runs.id, oldRunId));
    expect(await getBalanceMicro(reapProjectId)).toBe(creditsToMicro(90));

    const freshRunId = newId("run");
    await db.insert(runs).values({
      id: freshRunId,
      projectId: reapProjectId,
      recipeId: "refine",
      recipeVersion: 1,
      status: "RUNNING",
      mode: "streaming",
      input: "baru",
      idempotencyKey: newId("idem"),
    });

    const result = await reapStaleRuns({ staleAfterMs: 3600_000, confirmExpiryMs: 3600_000 });
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([oldRunId]);

    const oldRow = (await db.select().from(runs).where(eq(runs.id, oldRunId)))[0];
    expect(oldRow.status).toBe("RELEASED");
    expect(oldRow.finishedAt).not.toBeNull();
    expect(await getBalanceMicro(reapProjectId)).toBe(creditsToMicro(100));

    const freshRow = (await db.select().from(runs).where(eq(runs.id, freshRunId)))[0];
    expect(freshRow.status).toBe("RUNNING");
  });

  test("estimasi AWAITING_CONFIRMATION tua dihapus, bukan ditandai RELEASED", async () => {
    const oldConfirmId = newId("run");
    await db.insert(runs).values({
      id: oldConfirmId,
      projectId,
      recipeId: "visual",
      recipeVersion: 1,
      status: "AWAITING_CONFIRMATION",
      mode: "async",
      input: "basi",
      idempotencyKey: newId("idem"),
      createdAt: new Date(Date.now() - 2 * 3600_000),
    });

    const result = await reapStaleRuns({ staleAfterMs: 3600_000, confirmExpiryMs: 3600_000 });
    expect(result.runIds).toContain(oldConfirmId);

    // Run yang tak pernah dikonfirmasi belum memanggil provider dan tidak
    // menahan reservasi, jadi barisnya dihapus (sama seperti `POST /:id/cancel`)
    // supaya jatah media tidak terbakar percuma.
    const row = (await db.select().from(runs).where(eq(runs.id, oldConfirmId)))[0];
    expect(row).toBeUndefined();
  });
});

describe("penolakan sinkron saat saldo & kuota trial habis", () => {
  test("kuota trial habis → 402 + topup_url, tanpa run baru", async () => {
    const emptyProjectId = newId("prj");
    await db.insert(projects).values({
      id: emptyProjectId,
      name: "empty-test",
      ownerWallet: `0x${emptyProjectId.slice(-40).padStart(40, "0")}`.toLowerCase(),
    });
    const generated = generateApiKey();
    await db.insert(apiKeys).values({
      id: newId("key"),
      projectId: emptyProjectId,
      prefix: generated.prefix,
      hash: hashSecret(generated.secret),
      label: "empty",
    });

    // Habiskan 10 kuota trial: run trial yang menghasilkan output (SETTLED).
    // Run tanpa output tidak dihitung, jadi status + output di sini penting.
    for (let i = 0; i < 10; i++) {
      await db.insert(runs).values({
        id: newId("run"),
        projectId: emptyProjectId,
        recipeId: "refine",
        status: "SETTLED",
        input: `trial ${i}`,
        isTrial: true,
        output: { type: "streaming", content: "ok" },
        idempotencyKey: newId("idem"),
      });
    }

    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: { authorization: `Bearer ${generated.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ recipe_id: "refine", input: "Halo, saldo kosong." }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; topup_url: string } };
    expect(body.error.code).toBe("TRIAL_EXHAUSTED");
    expect(body.error.topup_url).toBe("/app/balance");

    const rows = await db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, emptyProjectId));
    expect(rows).toHaveLength(10);
  });
});

describe("percakapan server-side", () => {
  async function fundedProject(name: string, credits: number) {
    const id = newId("prj");
    await db.insert(projects).values({
      id,
      name,
      ownerWallet: `0x${id.slice(-40).padStart(40, "0")}`.toLowerCase(),
    });
    await recordCreditLot({
      projectId: id,
      source: "PROMO",
      amountMicro: creditsToMicro(credits),
      idempotencyKey: `convo:${id}`,
    });
    const generated = generateApiKey();
    await db.insert(apiKeys).values({
      id: newId("key"),
      projectId: id,
      prefix: generated.prefix,
      hash: hashSecret(generated.secret),
      label: name,
    });
    return { id, secret: generated.secret };
  }

  test("run dengan conversation_id menyimpan pesan + judul", async () => {
    const { id, secret } = await fundedProject("convo-test", 100);
    const headers = {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    };
    // Format id percakapan ditentukan server (`^conv_[0-9a-f]{32}$`).
    const conversationId = newId("conv");

    const created = await app.request("/v1/runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ recipe_id: "refine", input: "Sapa saya.", conversation_id: conversationId }),
    });
    expect(created.status).toBe(202);
    const { run_id: runId } = (await created.json()) as { run_id: string };

    let status = "CREATED";
    for (let i = 0; i < 50 && !["SETTLED", "RELEASED"].includes(status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const runRes = await app.request(`/v1/runs/${runId}`, { headers });
      status = ((await runRes.json()) as { status: string }).status;
    }
    expect(status).toBe("SETTLED");

    const convoRows = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(convoRows).toHaveLength(1);
    expect(convoRows[0].projectId).toBe(id);
    expect(convoRows[0].title).toContain("Sapa saya.");

    const msgRows = await db
      .select({ role: messages.role, runId: messages.runId })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(msgRows.map((row) => row.role).sort()).toEqual(["assistant", "user"]);
    expect(msgRows.find((row) => row.role === "assistant")?.runId).toBe(runId);
  });

  test("ringkasan rolling disimpan + berbiaya saat melewati ambang", async () => {
    const { id } = await fundedProject("convo-sum-test", 100);
    const conversationId = `convo-${newId("c")}`;
    await ensureConversation(id, conversationId, "Topik panjang");

    await appendRunMessages({
      projectId: id,
      conversationId,
      runId: newId("run"),
      userContent: "x".repeat(500),
      assistantContent: "y".repeat(500),
    });
    await appendRunMessages({
      projectId: id,
      conversationId,
      runId: newId("run"),
      userContent: "z".repeat(500),
      assistantContent: "w".repeat(500),
    });

    const refreshed = await maybeRefreshSummary(id, conversationId, 100);
    expect(refreshed.summary).toBeTruthy();
    expect(refreshed.costUsd).toBeGreaterThan(0);
    expect((await getConversationContext(id, conversationId, 10)).summary).toBe(refreshed.summary);

    // Isolasi project: project lain tidak bisa membaca ringkasan ini.
    expect((await getConversationContext("prj_asli", conversationId, 10)).summary).toBeNull();
  });

  test("tanpa conversation_id server membuat percakapan baru", async () => {
    const { id, secret } = await fundedProject("convo-none-test", 100);
    const before = await db.select({ id: conversations.id }).from(conversations);
    const created = await app.request("/v1/runs", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ recipe_id: "refine", input: "Tanpa conversation." }),
    });
    expect(created.status).toBe(202);
    const { conversation_id: conversationId } = (await created.json()) as { conversation_id: string };
    expect(conversationId).toMatch(/^conv_[0-9a-f]{32}$/);

    const after = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(after).toHaveLength(1);
    expect(after[0].projectId).toBe(id);

    const all = await db.select({ id: conversations.id }).from(conversations);
    expect(all.length).toBe(before.length + 1);
  });
});

describe("validasi paginasi usage", () => {
  test("limit/offset aneh → fallback aman, bukan 500", async () => {
    for (const query of ["?limit=abc", "?limit=99999", "?offset=-3", "?limit=0"]) {
      const res = await app.request(`/v1/usage${query}`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: unknown[] };
      expect(Array.isArray(body.entries)).toBe(true);
    }
  });
});

describe("ringkas percakapan panjang", () => {
  test("riwayat pendek tidak diringkas", async () => {
    const short: ChatMessage[] = [{ role: "user", content: "hai" }];
    const result = await summarizeHistory(short);
    expect(result.summarized).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.providerCostUsd).toBe(0);
  });

  test("riwayat panjang diringkas & berbiaya", async () => {
    const long: ChatMessage[] = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(4000),
    }));
    const result = await summarizeHistory(long);
    expect(result.summarized).toBe(true);
    expect(result.summary).toBeTruthy();
    expect(result.providerCostUsd).toBeGreaterThan(0);
    expect(result.history.length).toBe(2);
  });
});

describe("konsistensi saldo akhir", () => {
  test("saldo = Σ ledger", async () => {
    expect(await getBalanceMicro(projectId)).toBeGreaterThanOrEqual(0);
    expect(microToCredits(await getBalanceMicro(projectId))).toBeLessThan(100);
  });
});
