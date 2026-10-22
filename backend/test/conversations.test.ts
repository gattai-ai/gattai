import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { db } from "../src/db";
import { apiKeys, conversations, messages, projects, runSteps, runs } from "../src/db/schema";
import { generateApiKey, hashSecret } from "../src/lib/crypto";
import { newId } from "../src/lib/id";
import { createRun, syncRecipes } from "../src/orchestration/create-run";
import { reapStaleRuns } from "../src/orchestration/reap";
import {
  CONVERSATION_ID_PATTERN,
  appendRunMessages,
  ensureConversation,
  maybeRefreshSummary,
} from "../src/services/conversations";
import { OPENAI_TEXT, installFetch, makeMockFetch } from "./helpers/mock-fetch";

/**
 * Riwayat percakapan: id dibuat server, baris conversation dibuka saat run
 * dibuat (bukan menunggu settle), dan endpoint daftar/detail scoped per project.
 */

let restoreFetch: () => void;

/** Body request ke provider, untuk memeriksa konteks yang benar-benar dikirim. */
const providerBodies: string[] = [];

beforeAll(async () => {
  const base = makeMockFetch();
  restoreFetch = installFetch(async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/chat/completions") || url.includes("/v1/messages")) {
      providerBodies.push(String(init?.body ?? ""));
    }
    return base(input, init);
  });
  await syncRecipes();
});

afterAll(() => {
  restoreFetch?.();
});

function jsonHeaders(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

/** Project + API key tanpa saldo, cukup untuk menjalankan jalur trial. */
async function newProject(name: string): Promise<{ id: string; secret: string }> {
  const id = newId("prj");
  await db.insert(projects).values({
    id,
    name,
    ownerWallet: `0x${id.slice(-40).padStart(40, "0")}`.toLowerCase(),
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

interface PostResult {
  status: number;
  body: Record<string, unknown>;
}

/** Kode error dari bentuk seragam `{ error: { code, message } }`. */
function errorCode(body: unknown): string | undefined {
  const error = (body as { error?: { code?: string } }).error;
  return error?.code;
}

async function postRun(secret: string, body: Record<string, unknown>): Promise<PostResult> {
  const res = await app.request("/v1/runs", {
    method: "POST",
    headers: jsonHeaders(secret),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function countRuns(projectId: string): Promise<number> {
  const rows = await db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, projectId));
  return rows.length;
}

async function countConversations(projectId: string): Promise<number> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.projectId, projectId));
  return rows.length;
}

async function countMessages(conversationId: string): Promise<number> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return rows.length;
}

/** Baris run mentah di dalam sebuah percakapan (tanpa eksekusi provider). */
async function seedRun(input: {
  projectId: string;
  conversationId: string;
  createdAt: Date;
  status?: (typeof runs.$inferSelect)["status"];
  mode?: string;
  output?: unknown;
  /** Prompt tersimpan (`runs.input`); default "seed". */
  prompt?: string;
}): Promise<string> {
  const id = newId("run");
  await db.insert(runs).values({
    id,
    projectId: input.projectId,
    recipeId: "refine",
    status: input.status ?? "SETTLED",
    mode: input.mode ?? "streaming",
    conversationId: input.conversationId,
    input: input.prompt ?? "seed",
    output: input.output ?? { type: "streaming", content: "ok" },
    idempotencyKey: newId("idem"),
    createdAt: input.createdAt,
  });
  return id;
}

async function waitForTerminal(secret: string, runId: string): Promise<string> {
  let status = "CREATED";
  for (let i = 0; i < 100; i++) {
    const res = await app.request(`/v1/runs/${runId}`, { headers: jsonHeaders(secret) });
    status = ((await res.json()) as { status: string }).status;
    if (["SETTLED", "RELEASED", "INSUFFICIENT_BALANCE"].includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return status;
}

describe("percakapan: pembukaan saat run dibuat", () => {
  test("id dibuat server, baris conversation dibuka, judul dari prompt", async () => {
    const { id, secret } = await newProject("convo-open");
    const before = await countConversations(id);

    const res = await postRun(secret, { recipe_id: "refine", input: "Sapa saya dong." });
    expect(res.status).toBe(202);

    const conversationId = res.body.conversation_id;
    expect(typeof conversationId).toBe("string");
    expect(CONVERSATION_ID_PATTERN.test(conversationId as string)).toBe(true);

    // Baris conversation ada TANPA menunggu run selesai.
    expect(await countConversations(id)).toBe(before + 1);
    const rows = await db.select().from(conversations).where(eq(conversations.id, conversationId as string));
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBe(id);
    expect(rows[0].title).toContain("Sapa saya dong.");

    const runRow = (await db.select().from(runs).where(eq(runs.id, res.body.run_id as string)))[0];
    expect(runRow.conversationId).toBe(conversationId);

    // Beresi run yang menggantung.
    await waitForTerminal(secret, res.body.run_id as string);
  });

  test("turn kedua dengan id sama tidak membuka percakapan baru", async () => {
    const { id, secret } = await newProject("convo-continue");
    const first = await postRun(secret, { recipe_id: "refine", input: "Turn pertama." });
    expect(first.status).toBe(202);
    const conversationId = first.body.conversation_id as string;
    await waitForTerminal(secret, first.body.run_id as string);

    const second = await postRun(secret, {
      recipe_id: "refine",
      input: "Turn kedua.",
      conversation_id: conversationId,
    });
    expect(second.status).toBe(202);
    expect(second.body.conversation_id).toBe(conversationId);
    await waitForTerminal(secret, second.body.run_id as string);

    expect(await countConversations(id)).toBe(1);
    const rows = await db.select({ id: runs.id }).from(runs).where(eq(runs.conversationId, conversationId));
    expect(rows).toHaveLength(2);
  });

  test("formasi media yang berhenti di AWAITING_CONFIRMATION sudah terdaftar", async () => {
    const { id, secret } = await newProject("convo-media");

    const res = await postRun(secret, { recipe_id: "visual", input: "Bikin banner." });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("AWAITING_CONFIRMATION");
    expect(await countConversations(id)).toBe(1);

    const list = await app.request("/v1/conversations", { headers: jsonHeaders(secret) });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { conversations: Array<{ run_count: number }> };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].run_count).toBe(1);
  });

  test("judul fallback berbahasa Inggris saat input hanya spasi", async () => {
    const { id } = await newProject("convo-title");
    const row = await ensureConversation(id, newId("conv"), "   ");
    expect(row.title).toBe("New chat");
  });

  test("kolom title NOT NULL menolak baris tanpa judul", async () => {
    const { id } = await newProject("convo-title-notnull");
    let rejected = false;
    try {
      await db
        .insert(conversations)
        .values({ id: newId("conv"), projectId: id, title: null as unknown as string });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

describe("percakapan: validasi & kepemilikan", () => {
  test("format id ngawur ditolak 400 sebelum menyentuh DB", async () => {
    const { id, secret } = await newProject("convo-badid");
    for (const bad of ["abc", "conv_short", "run_0123456789abcdef0123456789abcdef"]) {
      const res = await postRun(secret, { recipe_id: "refine", input: "Halo.", conversation_id: bad });
      expect(res.status).toBe(400);
      expect(errorCode(res.body)).toBe("VALIDATION_ERROR");
    }
    expect(await countRuns(id)).toBe(0);
    expect(await countConversations(id)).toBe(0);
  });

  test("id milik project lain → 409, tanpa run/percakapan baru", async () => {
    const other = await newProject("convo-owner");
    const mine = await newProject("convo-thief");
    const foreignId = newId("conv");
    await ensureConversation(other.id, foreignId, "Punya orang lain");

    const res = await postRun(mine.secret, {
      recipe_id: "refine",
      input: "Pinjam id.",
      conversation_id: foreignId,
    });
    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe("CONVERSATION_ID_TAKEN");

    // Transaksi dibatalkan: tidak ada run maupun percakapan yang lahir.
    expect(await countRuns(mine.id)).toBe(0);
    expect(await countConversations(mine.id)).toBe(0);
    // Percakapan pemilik asli tidak tersentuh.
    expect(await countConversations(other.id)).toBe(1);
  });
});

describe("percakapan: endpoint daftar & transkrip", () => {
  test("daftar hanya milik sendiri, urut aktivitas terbaru, run_count benar", async () => {
    const mine = await newProject("convo-list");
    const other = await newProject("convo-list-other");

    const older = newId("conv");
    const newer = newId("conv");
    await ensureConversation(mine.id, older, "Lebih tua");
    await ensureConversation(mine.id, newer, "Lebih baru");
    await seedRun({ projectId: mine.id, conversationId: older, createdAt: new Date(Date.now() - 3600_000) });
    await seedRun({ projectId: mine.id, conversationId: newer, createdAt: new Date() });
    await seedRun({ projectId: mine.id, conversationId: newer, createdAt: new Date() });

    const theirs = newId("conv");
    await ensureConversation(other.id, theirs, "Punya orang lain");
    await seedRun({ projectId: other.id, conversationId: theirs, createdAt: new Date() });

    const res = await app.request("/v1/conversations", { headers: jsonHeaders(mine.secret) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ id: string; title: string; run_count: number; last_run_at: string | null }>;
    };
    expect(body.conversations.map((item) => item.id)).toEqual([newer, older]);
    expect(body.conversations[0].run_count).toBe(2);
    expect(body.conversations[1].run_count).toBe(1);
    expect(body.conversations[0].last_run_at).not.toBeNull();
  });

  test("percakapan tanpa run tidak muncul di daftar", async () => {
    const { id, secret } = await newProject("convo-empty");
    const withRun = newId("conv");
    const withoutRun = newId("conv");
    await ensureConversation(id, withRun, "Ada run");
    await ensureConversation(id, withoutRun, "Tidak ada run");
    await seedRun({ projectId: id, conversationId: withRun, createdAt: new Date() });

    const res = await app.request("/v1/conversations", { headers: jsonHeaders(secret) });
    const body = (await res.json()) as { conversations: Array<{ id: string }> };
    expect(body.conversations.map((item) => item.id)).toEqual([withRun]);
  });

  test("transkrip urut naik, menyertakan steps, dan melaporkan has_more", async () => {
    const { id, secret } = await newProject("convo-detail");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Tiga turn");

    const first = await seedRun({
      projectId: id,
      conversationId,
      createdAt: new Date(Date.now() - 3000),
      output: { type: "streaming", content: "jawaban satu" },
    });
    await db.insert(runSteps).values({
      id: newId("step"),
      runId: first,
      stepId: "interpret",
      provider: "mimo",
      model: "mimo-v2.6-flash",
      role: "writer",
      status: "COMPLETE",
    });
    await seedRun({ projectId: id, conversationId, createdAt: new Date(Date.now() - 2000) });
    await seedRun({ projectId: id, conversationId, createdAt: new Date(Date.now() - 1000) });

    const res = await app.request(`/v1/conversations/${conversationId}?limit=2`, {
      headers: jsonHeaders(secret),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { id: string; title: string };
      turns: Array<{
        run_id: string;
        input: string;
        status: string;
        created_at: string;
        steps?: Array<{ id: string; provider?: string; role?: string; role_label?: string }>;
      }>;
      has_more: boolean;
      next_cursor: string | null;
    };
    expect(body.conversation.id).toBe(conversationId);
    expect(body.has_more).toBe(true);
    expect(body.turns).toHaveLength(2);
    // `limit` mengambil 2 terbaru lalu dibalik → urut naik.
    expect(body.turns.map((turn) => turn.run_id)).not.toContain(first);
    expect(body.turns[0].input).toBe("seed");
    // Kursor halaman berikutnya = turn TERLAMA di halaman ini (`<ISO>|<id>`).
    expect(body.next_cursor).toBe(`${body.turns[0].created_at}|${body.turns[0].run_id}`);

    // Tanpa limit ketat, seluruh turn kembali dan steps ikut terkirim.
    const all = await app.request(`/v1/conversations/${conversationId}`, {
      headers: jsonHeaders(secret),
    });
    const allBody = (await all.json()) as typeof body;
    expect(allBody.has_more).toBe(false);
    expect(allBody.next_cursor).toBeNull();
    expect(allBody.turns).toHaveLength(3);
    expect(allBody.turns[0].run_id).toBe(first);
    expect(allBody.turns[0].steps?.[0].id).toBe("interpret");
    // Nama provider & role publik dari config, bukan provider internal.
    expect(allBody.turns[0].steps?.[0].provider).toBe("GPT");
    expect(allBody.turns[0].steps?.[0].role_label).toBe("interpret");
    // Tidak ada jejak provider internal di seluruh response.
    expect(JSON.stringify(allBody)).not.toContain("mimo");
  });

  test("percakapan milik project lain → 404, bukan 403 yang membocorkan", async () => {
    const other = await newProject("convo-private");
    const mine = await newProject("convo-nosy");
    const foreignId = newId("conv");
    await ensureConversation(other.id, foreignId, "Privat");

    const res = await app.request(`/v1/conversations/${foreignId}`, { headers: jsonHeaders(mine.secret) });
    expect(res.status).toBe(404);
    expect(errorCode(await res.json())).toBe("CONVERSATION_NOT_FOUND");
  });

  test("id yang tidak pernah ada → 404", async () => {
    const { secret } = await newProject("convo-missing");
    const res = await app.request(`/v1/conversations/${newId("conv")}`, { headers: jsonHeaders(secret) });
    expect(res.status).toBe(404);
  });

  test("format id ngawur → 404 sebelum menyentuh DB", async () => {
    const { secret } = await newProject("convo-badformat");
    const res = await app.request("/v1/conversations/bukan-conv-id", { headers: jsonHeaders(secret) });
    expect(res.status).toBe(404);
    expect(errorCode(await res.json())).toBe("CONVERSATION_NOT_FOUND");
  });
});

describe("percakapan: plafon riwayat & replay idempotent", () => {
  test("history tepat 50 entri diterima, 51 ditolak", async () => {
    const { secret } = await newProject("convo-historycap");
    const entry = (index: number) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `pesan ${index}`,
    });

    const ok = await postRun(secret, {
      recipe_id: "refine",
      input: "Halo.",
      history: Array.from({ length: 50 }, (_, index) => entry(index)),
    });
    expect(ok.status).toBe(202);
    await waitForTerminal(secret, ok.body.run_id as string);

    // Batas 50 berlaku untuk klien API yang masih mengirim `history`; UI web
    // tidak lagi mengirimnya (konteks diambil server dari `messages`).
    const tooMany = await postRun(secret, {
      recipe_id: "refine",
      input: "Halo.",
      history: Array.from({ length: 51 }, (_, index) => entry(index)),
    });
    expect(tooMany.status).toBe(400);
    expect(errorCode(tooMany.body)).toBe("VALIDATION_ERROR");
  });

  test("replay Idempotency-Key ditandai replayed tanpa menjalankan run lagi", async () => {
    const { id } = await newProject("convo-replayed");
    const idempotencyKey = newId("idem");

    // `createRun` tidak mengeksekusi run, jadi statusnya tetap CREATED — persis
    // jendela balapan yang sebelumnya memicu eksekusi ganda di `POST /v1/runs`.
    const first = await createRun({
      projectId: id,
      recipeId: "refine",
      input: "Sekali saja.",
      idempotencyKey,
    });
    expect(first.replayed).toBe(false);
    expect(first.run.status).toBe("CREATED");

    const again = await createRun({
      projectId: id,
      recipeId: "refine",
      input: "Sekali saja.",
      idempotencyKey,
    });
    expect(again.replayed).toBe(true);
    expect(again.run.id).toBe(first.run.id);
    expect(await countRuns(id)).toBe(1);
  });

  test("pesan user & assistant diberi waktu menaik", async () => {
    const { id } = await newProject("convo-ordering");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Urutan pesan");
    await appendRunMessages({
      projectId: id,
      conversationId,
      runId: newId("run"),
      userContent: "pertanyaan",
      assistantContent: "jawaban",
    });

    const rows = await db
      .select({ role: messages.role, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt, messages.id);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[1].createdAt.getTime()).toBeGreaterThan(rows[0].createdAt.getTime());
  });
});

describe("percakapan: jalur API stateless", () => {
  test("/v1/chat/completions tidak membuka percakapan", async () => {
    const { id, secret } = await newProject("convo-api-stateless");
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({
        model: "gattai/refine",
        messages: [{ role: "user", content: "Halo dari jalur API." }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gattai: { status: string; run_id: string } };
    expect(body.gattai.status).toBe("SETTLED");

    // Tanpa percakapan: tidak ada entri riwayat satu-turn dan tidak ada panggilan
    // ringkasan (yang biayanya dibebankan ke run).
    expect(await countConversations(id)).toBe(0);
    const runRow = await db.select().from(runs).where(eq(runs.id, body.gattai.run_id));
    expect(runRow[0].conversationId).toBeNull();
  });

  test("/v1/runs tetap membuka percakapan (regresi)", async () => {
    const { id, secret } = await newProject("convo-web-opens");
    const created = await postRun(secret, { recipe_id: "refine", input: "Dari web chat." });
    expect(created.status).toBe(202);
    expect(created.body.conversation_id).toMatch(CONVERSATION_ID_PATTERN);
    expect(await countConversations(id)).toBe(1);
  });
});

describe("percakapan: konteks run dari server", () => {
  test("run tanpa history memakai messages dari DB", async () => {
    const { id, secret } = await newProject("convo-context");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Konteks");
    const seededRun = await seedRun({ projectId: id, conversationId, createdAt: new Date() });
    await appendRunMessages({
      projectId: id,
      conversationId,
      runId: seededRun,
      userContent: "MARKER-DB-USER",
      assistantContent: "MARKER-DB-ASSISTANT",
    });

    providerBodies.length = 0;
    const res = await postRun(secret, {
      recipe_id: "refine",
      input: "Lanjutkan percakapan.",
      conversation_id: conversationId,
    });
    expect(res.status).toBe(202);
    expect(await waitForTerminal(secret, res.body.run_id as string)).toBe("SETTLED");

    const sent = providerBodies.join("\n");
    expect(sent).toContain("MARKER-DB-USER");
    expect(sent).toContain("MARKER-DB-ASSISTANT");
  });

  test("history eksplisit dari klien API tetap dihormati", async () => {
    const { id, secret } = await newProject("convo-context-v1");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Konteks v1");
    const seededRun = await seedRun({ projectId: id, conversationId, createdAt: new Date() });
    await appendRunMessages({
      projectId: id,
      conversationId,
      runId: seededRun,
      userContent: "MARKER-DB-USER",
      assistantContent: "MARKER-DB-ASSISTANT",
    });

    providerBodies.length = 0;
    const res = await postRun(secret, {
      recipe_id: "refine",
      input: "Lanjutkan percakapan.",
      conversation_id: conversationId,
      history: [{ role: "user", content: "MARKER-CLIENT-HISTORY" }],
    });
    expect(res.status).toBe(202);
    expect(await waitForTerminal(secret, res.body.run_id as string)).toBe("SETTLED");

    const sent = providerBodies.join("\n");
    expect(sent).toContain("MARKER-CLIENT-HISTORY");
    expect(sent).not.toContain("MARKER-DB-USER");
  });

  test("ringkasan percakapan masuk sebagai pesan sistem step execute", async () => {
    const { id, secret } = await newProject("convo-summary-prompt");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Ringkasan");
    await db
      .update(conversations)
      .set({ summary: "MARKER-SUMMARY-456" })
      .where(eq(conversations.id, conversationId));

    providerBodies.length = 0;
    const res = await postRun(secret, {
      recipe_id: "refine",
      input: "Lanjutkan.",
      conversation_id: conversationId,
    });
    expect(res.status).toBe(202);
    expect(await waitForTerminal(secret, res.body.run_id as string)).toBe("SETTLED");

    // Step execute adalah satu-satunya yang streaming (interpreter meminta JSON).
    const execute = providerBodies
      .map(
        (body) =>
          JSON.parse(body) as {
            stream?: boolean;
            stream_options?: { include_usage?: boolean };
            messages?: Array<{ role: string; content: string }>;
          },
      )
      .find((body) => body.stream === true);
    expect(execute).toBeDefined();
    expect(execute?.stream_options?.include_usage).toBe(true);
    expect(execute?.messages?.[0]?.role).toBe("system");
    expect(execute?.messages?.[0]?.content).toContain("MARKER-SUMMARY-456");
  });

  test("ringkasan yang dibuat memangkas messages, ringkasan lama ikut dirangkum", async () => {
    const { id } = await newProject("convo-prune");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Pangkas");
    const seededRun = await seedRun({ projectId: id, conversationId, createdAt: new Date() });
    const appendTurn = async (index: number) => {
      await appendRunMessages({
        projectId: id,
        conversationId,
        runId: seededRun,
        userContent: `pertanyaan panjang ${index} ${"x".repeat(80)}`,
        assistantContent: `jawaban panjang ${index} ${"y".repeat(80)}`,
      });
      // `created_at` adalah pengurut utama; dua turn yang ditulis dalam
      // milidetik yang sama bisa bertukar urutan lewat tiebreak `id` acak.
      // Beri jeda kecil agar urutan deterministik (di produksi turn berjarak
      // detik karena menunggu provider).
      await new Promise((resolve) => setTimeout(resolve, 2));
    };
    for (let index = 0; index < 4; index++) await appendTurn(index);
    expect(await countMessages(conversationId)).toBe(8);

    const first = await maybeRefreshSummary(id, conversationId, 100);
    expect(first.summary).not.toBeNull();
    // Turn yang sudah masuk ringkasan dipangkas; hanya ekor verbatim tersisa.
    expect(await countMessages(conversationId)).toBe(2);

    providerBodies.length = 0;
    await appendTurn(4);
    await appendTurn(5);
    const second = await maybeRefreshSummary(id, conversationId, 100);
    expect(second.summary).not.toBeNull();
    // Transkrip yang dirangkum kini hanya berisi ekor + pesan baru, jadi
    // ringkasan lama wajib ikut sebagai bahan — kalau tidak, awal percakapan
    // hilang dari ringkasan berikutnya.
    expect(providerBodies.join("\n")).toContain(OPENAI_TEXT);
    expect(await countMessages(conversationId)).toBe(2);
    const tail = await db
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt, messages.id);
    expect(tail[1].content).toContain("jawaban panjang 5");
  });
});

describe("percakapan: pagination kursor", () => {
  test("transkrip: halaman berikutnya lewat kursor `before`", async () => {
    const { id, secret } = await newProject("convo-cursor");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Empat turn");
    const ids = [
      await seedRun({ projectId: id, conversationId, createdAt: new Date(Date.now() - 4000) }),
      await seedRun({ projectId: id, conversationId, createdAt: new Date(Date.now() - 3000) }),
      await seedRun({ projectId: id, conversationId, createdAt: new Date(Date.now() - 2000) }),
      await seedRun({ projectId: id, conversationId, createdAt: new Date(Date.now() - 1000) }),
    ];

    const first = await app.request(`/v1/conversations/${conversationId}?limit=2`, {
      headers: jsonHeaders(secret),
    });
    const firstBody = (await first.json()) as {
      turns: Array<{ run_id: string; created_at: string }>;
      has_more: boolean;
      next_cursor: string | null;
    };
    expect(firstBody.has_more).toBe(true);
    // Halaman pertama = 2 turn TERBARU, dibalik jadi urut naik.
    expect(firstBody.turns.map((turn) => turn.run_id)).toEqual([ids[2], ids[3]]);
    // Kursor datang dari server, klien tidak merakitnya sendiri.
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await app.request(
      `/v1/conversations/${conversationId}?limit=2&before=${encodeURIComponent(firstBody.next_cursor as string)}`,
      { headers: jsonHeaders(secret) },
    );
    const secondBody = (await second.json()) as typeof firstBody;
    expect(secondBody.turns.map((turn) => turn.run_id)).toEqual([ids[0], ids[1]]);
    expect(secondBody.has_more).toBe(false);
    expect(secondBody.next_cursor).toBeNull();
  });

  test("kursor ngawur → 400 INVALID_CURSOR", async () => {
    const { secret } = await newProject("convo-badcursor");
    const conversationId = newId("conv");
    for (const bad of ["bukankursor", "2020-01-01T00:00:00.000Z|"]) {
      const res = await app.request(
        `/v1/conversations/${conversationId}?before=${encodeURIComponent(bad)}`,
        { headers: jsonHeaders(secret) },
      );
      expect(res.status).toBe(400);
      expect(errorCode(await res.json())).toBe("INVALID_CURSOR");
    }
  });

  test("daftar: halaman berikutnya lewat `next_cursor`", async () => {
    const { id, secret } = await newProject("convo-listcursor");
    const base = Date.now();
    const ids = [0, 1, 2].map(() => newId("conv"));
    for (const [index, conversationId] of ids.entries()) {
      await ensureConversation(id, conversationId, `Percakapan ${index}`);
      await seedRun({
        projectId: id,
        conversationId,
        createdAt: new Date(base - (2 - index) * 60_000),
      });
    }

    const first = await app.request("/v1/conversations?limit=2", { headers: jsonHeaders(secret) });
    const firstBody = (await first.json()) as {
      conversations: Array<{ id: string }>;
      has_more: boolean;
      next_cursor: string | null;
    };
    expect(firstBody.conversations.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(firstBody.has_more).toBe(true);
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await app.request(
      `/v1/conversations?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor as string)}`,
      { headers: jsonHeaders(secret) },
    );
    const secondBody = (await second.json()) as typeof firstBody;
    expect(secondBody.conversations.map((item) => item.id)).toEqual([ids[0]]);
    expect(secondBody.has_more).toBe(false);
    expect(secondBody.next_cursor).toBeNull();
  });
});

describe("percakapan: pembersihan percakapan yatim", () => {
  test("cancel run media menghapus percakapan yang kehilangan run terakhir", async () => {
    const { id, secret } = await newProject("convo-cancel-clean");
    const created = await postRun(secret, { recipe_id: "visual", input: "Bikin banner." });
    expect(created.status).toBe(202);
    expect(created.body.status).toBe("AWAITING_CONFIRMATION");
    expect(await countConversations(id)).toBe(1);

    const cancelled = await app.request(`/v1/runs/${created.body.run_id as string}/cancel`, {
      method: "POST",
      headers: jsonHeaders(secret),
    });
    expect(cancelled.status).toBe(200);
    expect(await countConversations(id)).toBe(0);
  });

  test("cancel tidak menghapus percakapan yang masih punya run lain", async () => {
    const { id, secret } = await newProject("convo-cancel-keep");
    const first = await postRun(secret, { recipe_id: "refine", input: "Turn pertama." });
    const conversationId = first.body.conversation_id as string;
    await waitForTerminal(secret, first.body.run_id as string);

    const media = await postRun(secret, {
      recipe_id: "visual",
      input: "Bikin banner.",
      conversation_id: conversationId,
    });
    expect(media.status).toBe(202);
    expect(media.body.status).toBe("AWAITING_CONFIRMATION");

    const cancelled = await app.request(`/v1/runs/${media.body.run_id as string}/cancel`, {
      method: "POST",
      headers: jsonHeaders(secret),
    });
    expect(cancelled.status).toBe(200);
    // Run teksnya masih ada → percakapan tetap hidup.
    expect(await countConversations(id)).toBe(1);
  });

  test("reaper menghapus percakapan yang kehilangan run terakhirnya", async () => {
    const { id, secret } = await newProject("convo-reap-clean");
    const created = await postRun(secret, { recipe_id: "visual", input: "Bikin banner." });
    const runId = created.body.run_id as string;
    expect(created.body.status).toBe("AWAITING_CONFIRMATION");
    expect(await countConversations(id)).toBe(1);

    // Mundurkan HANYA run ini. `confirmExpiryMs` negatif akan meng-expire semua
    // run berstatus sama milik berkas test lain di DB yang dipakai bersama.
    await db
      .update(runs)
      .set({ createdAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(runs.id, runId));

    const reaped = await reapStaleRuns({ staleAfterMs: 3600_000, confirmExpiryMs: 3600_000 });
    expect(reaped.runIds).toContain(runId);
    expect(await countConversations(id)).toBe(0);
  });

  test("reaper tidak menghapus percakapan yang masih punya run lain", async () => {
    const { id, secret } = await newProject("convo-reap-keep");
    const first = await postRun(secret, { recipe_id: "refine", input: "Turn pertama." });
    const conversationId = first.body.conversation_id as string;
    await waitForTerminal(secret, first.body.run_id as string);

    const media = await postRun(secret, {
      recipe_id: "visual",
      input: "Bikin banner.",
      conversation_id: conversationId,
    });
    const mediaRunId = media.body.run_id as string;
    expect(media.body.status).toBe("AWAITING_CONFIRMATION");

    await db
      .update(runs)
      .set({ createdAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(runs.id, mediaRunId));

    const reaped = await reapStaleRuns({ staleAfterMs: 3600_000, confirmExpiryMs: 3600_000 });
    expect(reaped.runIds).toContain(mediaRunId);
    // Run teksnya masih ada → percakapan tetap hidup.
    expect(await countConversations(id)).toBe(1);
  });
});

describe("percakapan: ganti judul", () => {
  test("PATCH mengganti judul dan bertahan di daftar & transkrip", async () => {
    const { id, secret } = await newProject("convo-rename");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Judul lama");
    await seedRun({ projectId: id, conversationId, createdAt: new Date() });

    const res = await app.request(`/v1/conversations/${conversationId}`, {
      method: "PATCH",
      headers: jsonHeaders(secret),
      // Spasi di ujung dipangkas server.
      body: JSON.stringify({ title: "  Judul baru  " }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { id: string; title: string } };
    expect(body.conversation.id).toBe(conversationId);
    expect(body.conversation.title).toBe("Judul baru");

    const list = await app.request("/v1/conversations", { headers: jsonHeaders(secret) });
    const listBody = (await list.json()) as {
      conversations: Array<{ id: string; title: string | null }>;
    };
    expect(listBody.conversations.find((item) => item.id === conversationId)?.title).toBe("Judul baru");

    const detail = await app.request(`/v1/conversations/${conversationId}`, {
      headers: jsonHeaders(secret),
    });
    const detailBody = (await detail.json()) as { conversation: { title: string | null } };
    expect(detailBody.conversation.title).toBe("Judul baru");
  });

  test("judul kosong / hanya spasi / terlalu panjang ditolak 400", async () => {
    const { id, secret } = await newProject("convo-rename-bad");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Judul asli");

    for (const title of ["", "   ", "x".repeat(81)]) {
      const res = await app.request(`/v1/conversations/${conversationId}`, {
        method: "PATCH",
        headers: jsonHeaders(secret),
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(400);
      expect(errorCode(await res.json())).toBe("VALIDATION_ERROR");
    }
    const rows = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(rows[0].title).toBe("Judul asli");
  });

  test("percakapan project lain → 404, judulnya tidak tersentuh", async () => {
    const other = await newProject("convo-rename-owner");
    const mine = await newProject("convo-rename-nosy");
    const foreignId = newId("conv");
    await ensureConversation(other.id, foreignId, "Milik orang lain");

    const res = await app.request(`/v1/conversations/${foreignId}`, {
      method: "PATCH",
      headers: jsonHeaders(mine.secret),
      body: JSON.stringify({ title: "Dibajak" }),
    });
    expect(res.status).toBe(404);
    const rows = await db.select().from(conversations).where(eq(conversations.id, foreignId));
    expect(rows[0].title).toBe("Milik orang lain");
  });

  test("id ngawur → 404 sebelum menyentuh DB", async () => {
    const { secret } = await newProject("convo-rename-badid");
    const res = await app.request("/v1/conversations/bukan-conv-id", {
      method: "PATCH",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ title: "Apa saja" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("percakapan: hapus", () => {
  test("DELETE menghapus percakapan + pesan, melepas tautan run, dan 204", async () => {
    const { id, secret } = await newProject("convo-delete");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Akan dihapus");
    const runId = await seedRun({ projectId: id, conversationId, createdAt: new Date() });
    await appendRunMessages({
      projectId: id,
      conversationId,
      runId,
      userContent: "Hapus saya",
      assistantContent: "Baik",
    });
    expect(await countMessages(conversationId)).toBe(2);

    const res = await app.request(`/v1/conversations/${conversationId}`, {
      method: "DELETE",
      headers: jsonHeaders(secret),
    });
    expect(res.status).toBe(204);

    expect(await countConversations(id)).toBe(0);
    // Pesan ikut terhapus lewat cascade.
    expect(await countMessages(conversationId)).toBe(0);
    // Run tetap ada, hanya tautannya dilepas (bukan ikut terhapus).
    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    expect(runRows).toHaveLength(1);
    expect(runRows[0].conversationId).toBeNull();

    // Hilang dari daftar & transkrip.
    const list = await app.request("/v1/conversations", { headers: jsonHeaders(secret) });
    const listBody = (await list.json()) as { conversations: Array<{ id: string }> };
    expect(listBody.conversations.some((item) => item.id === conversationId)).toBe(false);
    const detail = await app.request(`/v1/conversations/${conversationId}`, {
      headers: jsonHeaders(secret),
    });
    expect(detail.status).toBe(404);
  });

  test("DELETE ditolak 409 selama masih ada run aktif", async () => {
    const { id, secret } = await newProject("convo-delete-active");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Sedang jalan");
    await seedRun({ projectId: id, conversationId, createdAt: new Date(), status: "RUNNING" });

    const res = await app.request(`/v1/conversations/${conversationId}`, {
      method: "DELETE",
      headers: jsonHeaders(secret),
    });
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe("CONVERSATION_ACTIVE");
    // Percakapan tetap utuh.
    expect(await countConversations(id)).toBe(1);
  });

  test("DELETE mengizinkan run yang sudah terminal", async () => {
    const { id, secret } = await newProject("convo-delete-terminal");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Sudah selesai");
    await seedRun({ projectId: id, conversationId, createdAt: new Date(), status: "SETTLED" });

    const res = await app.request(`/v1/conversations/${conversationId}`, {
      method: "DELETE",
      headers: jsonHeaders(secret),
    });
    expect(res.status).toBe(204);
    expect(await countConversations(id)).toBe(0);
  });

  test("percakapan project lain → 404, tidak terhapus", async () => {
    const other = await newProject("convo-delete-owner");
    const mine = await newProject("convo-delete-nosy");
    const foreignId = newId("conv");
    await ensureConversation(other.id, foreignId, "Milik orang lain");
    await seedRun({ projectId: other.id, conversationId: foreignId, createdAt: new Date() });

    const res = await app.request(`/v1/conversations/${foreignId}`, {
      method: "DELETE",
      headers: jsonHeaders(mine.secret),
    });
    expect(res.status).toBe(404);
    expect(await countConversations(other.id)).toBe(1);
  });

  test("id ngawur & id tidak ada → 404", async () => {
    const { secret } = await newProject("convo-delete-missing");
    for (const path of ["/v1/conversations/bukan-conv-id", `/v1/conversations/${newId("conv")}`]) {
      const res = await app.request(path, { method: "DELETE", headers: jsonHeaders(secret) });
      expect(res.status).toBe(404);
    }
  });
});

describe("percakapan: pencarian daftar", () => {
  test("mencocokkan judul (case-insensitive) tanpa mengubah run_count", async () => {
    const { id, secret } = await newProject("convo-search-title");
    const match = newId("conv");
    const other = newId("conv");
    await ensureConversation(id, match, "Bikin Banner Promo");
    await ensureConversation(id, other, "Tulis kode retry");
    await seedRun({ projectId: id, conversationId: match, createdAt: new Date(Date.now() - 1000) });
    await seedRun({ projectId: id, conversationId: match, createdAt: new Date() });
    await seedRun({ projectId: id, conversationId: other, createdAt: new Date() });

    const res = await app.request("/v1/conversations?q=banner", { headers: jsonHeaders(secret) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ id: string; run_count: number }>;
    };
    expect(body.conversations.map((item) => item.id)).toEqual([match]);
    // Semua run percakapan ini tetap dihitung, bukan hanya yang cocok.
    expect(body.conversations[0].run_count).toBe(2);
  });

  test("mencocokkan isi prompt (`runs.input`) dan tetap menghitung semua run", async () => {
    const { id, secret } = await newProject("convo-search-input");
    const match = newId("conv");
    await ensureConversation(id, match, "Judul netral");
    // Run lama memuat kata kunci, run baru tidak: `run_count` harus tetap 2 dan
    // `last_run_at` tetap dari run TERBARU (bukan run yang cocok).
    const newest = await seedRun({ projectId: id, conversationId: match, createdAt: new Date() });
    await seedRun({
      projectId: id,
      conversationId: match,
      createdAt: new Date(Date.now() - 60_000),
      prompt: "MARKER-QUERY-UNIK",
    });

    const other = newId("conv");
    await ensureConversation(id, other, "Judul netral lain");
    await seedRun({ projectId: id, conversationId: other, createdAt: new Date() });

    const res = await app.request("/v1/conversations?q=MARKER-QUERY-UNIK", {
      headers: jsonHeaders(secret),
    });
    const body = (await res.json()) as {
      conversations: Array<{ id: string; run_count: number; last_run_at: string | null }>;
    };
    expect(body.conversations.map((item) => item.id)).toEqual([match]);
    expect(body.conversations[0].run_count).toBe(2);
    const newestRow = await db.select().from(runs).where(eq(runs.id, newest));
    expect(new Date(body.conversations[0].last_run_at ?? 0).getTime()).toBe(
      newestRow[0].createdAt.getTime(),
    );
  });

  test("pencarian tidak menembus project lain", async () => {
    const mine = await newProject("convo-search-mine");
    const other = await newProject("convo-search-other");
    const theirs = newId("conv");
    await ensureConversation(other.id, theirs, "Rahasia banner orang lain");
    await seedRun({ projectId: other.id, conversationId: theirs, createdAt: new Date() });

    const res = await app.request("/v1/conversations?q=banner", { headers: jsonHeaders(mine.secret) });
    const body = (await res.json()) as { conversations: Array<{ id: string }> };
    expect(body.conversations).toHaveLength(0);
  });

  test("`%` diperlakukan sebagai karakter biasa, bukan wildcard", async () => {
    const { id, secret } = await newProject("convo-search-wildcard");
    const plain = newId("conv");
    await ensureConversation(id, plain, "Judul biasa");
    await seedRun({ projectId: id, conversationId: plain, createdAt: new Date() });

    const res = await app.request(`/v1/conversations?q=${encodeURIComponent("%")}`, {
      headers: jsonHeaders(secret),
    });
    const body = (await res.json()) as { conversations: Array<{ id: string }> };
    expect(body.conversations).toHaveLength(0);
  });

  test("kursor tetap bekerja saat pencarian aktif", async () => {
    const { id, secret } = await newProject("convo-search-cursor");
    const ids = [0, 1, 2].map(() => newId("conv"));
    for (const [index, conversationId] of ids.entries()) {
      await ensureConversation(id, conversationId, `Proyek alpha ${index}`);
      await seedRun({
        projectId: id,
        conversationId,
        createdAt: new Date(Date.now() - (2 - index) * 60_000),
      });
    }

    const first = await app.request("/v1/conversations?q=alpha&limit=2", {
      headers: jsonHeaders(secret),
    });
    const firstBody = (await first.json()) as {
      conversations: Array<{ id: string }>;
      has_more: boolean;
      next_cursor: string | null;
    };
    expect(firstBody.conversations.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(firstBody.has_more).toBe(true);

    const second = await app.request(
      `/v1/conversations?q=alpha&limit=2&cursor=${encodeURIComponent(firstBody.next_cursor as string)}`,
      { headers: jsonHeaders(secret) },
    );
    const secondBody = (await second.json()) as typeof firstBody;
    expect(secondBody.conversations.map((item) => item.id)).toEqual([ids[0]]);
    expect(secondBody.has_more).toBe(false);
  });
});
