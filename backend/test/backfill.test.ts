import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { db } from "../src/db";
import { apiKeys, conversations, messages, projects, runs } from "../src/db/schema";
import { generateApiKey, hashSecret } from "../src/lib/crypto";
import { newId } from "../src/lib/id";
import { backfillConversations } from "../src/services/backfill";
import { ensureConversation } from "../src/services/conversations";

/**
 * Backfill tautan percakapan lama: memulihkan `runs.conversation_id` dari
 * `messages`, idempoten, tidak menyentuh run milik project lain, dan melaporkan
 * anomali lintas project alih-alih menautkannya.
 */

function jsonHeaders(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

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

async function runRow(runId: string) {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));
  return rows[0];
}

/**
 * Bentuk "pra-fase C": percakapan sudah ada dan pesannya menunjuk ke sana, tapi
 * run-nya belum punya `conversation_id`.
 */
async function seedLegacyRun(
  projectId: string,
  conversationId: string,
  prompt = "prompt lama",
): Promise<string> {
  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    projectId,
    recipeId: "refine",
    status: "SETTLED",
    conversationId: null,
    input: prompt,
    output: { type: "streaming", content: "ok" },
    idempotencyKey: newId("idem"),
  });
  const base = Date.now();
  await db.insert(messages).values([
    {
      id: newId("msg"),
      conversationId,
      role: "user",
      content: prompt,
      createdAt: new Date(base),
    },
    {
      id: newId("msg"),
      conversationId,
      role: "assistant",
      content: "ok",
      runId,
      createdAt: new Date(base + 1),
    },
  ]);
  return runId;
}

describe("backfill: dry-run", () => {
  test("menghitung kandidat tanpa mengubah apa pun", async () => {
    const { id } = await newProject("backfill-dry");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Legacy");
    const runId = await seedLegacyRun(id, conversationId);

    const report = await backfillConversations({ dryRun: true, projectId: id });
    expect(report.dryRun).toBe(true);
    expect(report.linked).toBe(1);
    expect(report.batches).toBe(0);
    expect(report.links).toHaveLength(0);
    expect((await runRow(runId)).conversationId).toBeNull();
  });

  test("default tanpa opsi = dry-run (tidak menulis)", async () => {
    const { id } = await newProject("backfill-default-dry");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Legacy default");
    const runId = await seedLegacyRun(id, conversationId);

    const report = await backfillConversations({ projectId: id });
    expect(report.dryRun).toBe(true);
    expect((await runRow(runId)).conversationId).toBeNull();
  });
});

describe("backfill: apply", () => {
  test("menautkan run, memunculkan percakapan di riwayat, dan idempoten", async () => {
    const { id, secret } = await newProject("backfill-apply");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Legacy apply");
    const runId = await seedLegacyRun(id, conversationId);

    const report = await backfillConversations({ dryRun: false, projectId: id });
    expect(report.linked).toBe(1);
    expect(report.links[0]).toEqual({ runId, conversationId, projectId: id });
    expect((await runRow(runId)).conversationId).toBe(conversationId);

    // Percakapan kini muncul di daftar riwayat.
    const res = await app.request("/v1/conversations", { headers: jsonHeaders(secret) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ id: string }> };
    expect(body.conversations.map((item) => item.id)).toContain(conversationId);

    // Dijalankan lagi: tidak ada yang berubah.
    const again = await backfillConversations({ dryRun: false, projectId: id });
    expect(again.linked).toBe(0);
    expect(again.batches).toBe(0);
  });

  test("run yang sudah punya tautan tidak disentuh", async () => {
    const { id } = await newProject("backfill-already");
    const conversationId = newId("conv");
    await ensureConversation(id, conversationId, "Sudah tertaut");
    const runId = await seedLegacyRun(id, conversationId);
    await db.update(runs).set({ conversationId }).where(eq(runs.id, runId));

    const report = await backfillConversations({ dryRun: false, projectId: id });
    expect(report.linked).toBe(0);
    expect((await runRow(runId)).conversationId).toBe(conversationId);
  });

  test("membagi pekerjaan per batch", async () => {
    const { id } = await newProject("backfill-batch");
    for (let index = 0; index < 3; index++) {
      const conversationId = newId("conv");
      await ensureConversation(id, conversationId, `Batch ${index}`);
      await seedLegacyRun(id, conversationId);
    }

    const report = await backfillConversations({ dryRun: false, projectId: id, batchSize: 1 });
    expect(report.linked).toBe(3);
    expect(report.batches).toBe(3);
  });
});

describe("backfill: anomali lintas project", () => {
  test("run dengan pesan milik project lain dilaporkan, bukan ditautkan", async () => {
    const mine = await newProject("backfill-conflict-mine");
    const other = await newProject("backfill-conflict-other");
    const foreignConversation = newId("conv");
    await ensureConversation(other.id, foreignConversation, "Punya project lain");

    const runId = newId("run");
    await db.insert(runs).values({
      id: runId,
      projectId: mine.id,
      recipeId: "refine",
      status: "SETTLED",
      conversationId: null,
      input: "korup",
      idempotencyKey: newId("idem"),
    });
    await db.insert(messages).values({
      id: newId("msg"),
      conversationId: foreignConversation,
      role: "assistant",
      content: "korup",
      runId,
      createdAt: new Date(),
    });

    const report = await backfillConversations({ dryRun: false, projectId: mine.id });
    expect(report.linked).toBe(0);
    expect(report.conflicts).toBe(1);
    expect(report.conflictSamples[0]).toContain(runId);
    // Tautan tidak dibuat, percakapan project lain juga tidak tersentuh.
    expect((await runRow(runId)).conversationId).toBeNull();
    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, foreignConversation));
    expect(rows).toHaveLength(1);
  });
});
