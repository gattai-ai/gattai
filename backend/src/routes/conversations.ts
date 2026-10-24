import { and, desc, eq, exists, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db";
import { conversations, runShares, runSteps, runs } from "../db/schema";
import { env } from "../env";
import { ApiError } from "../lib/http";
import { parseLimit, readCursor } from "../lib/pagination";
import { readSearchPattern } from "../lib/search";
import { createRateLimiter } from "../middleware/rate-limit";
import { requireProject } from "../middleware/auth";
import { serializeRun } from "../serialize";
import { CONVERSATION_ID_PATTERN } from "../services/conversations";
import { revokeSharesForConversation } from "../services/shares";
import type { AppEnv } from "../types";

/**
 * Riwayat percakapan.
 *
 * Percakapan dibuka oleh `createRun` (lihat `orchestration/create-run.ts`) untuk
 * jalur web — termasuk formasi media yang berhenti di `AWAITING_CONFIRMATION`.
 * Run jalur API (`POST /v1/chat/completions`) sengaja TIDAK punya percakapan
 * (`openConversation: false`), jadi `runs.conversation_id` boleh `null`.
 * Endpoint di sini mayoritas membaca; `PATCH`/`DELETE` mengubah satu percakapan
 * (ganti judul, hapus) dan tidak pernah menyentuh riwayat billing.
 *
 * Transkrip dibangun dari tabel `runs`, bukan `messages`: `messages` menyimpan
 * konteks untuk ringkasan, sedangkan `runs` sudah memuat teks akhir
 * (`output.content`), media (`output.media`), status, biaya, dan `is_trial` —
 * persis yang dibutuhkan UI untuk menggambar ulang kartu run.
 */
export const conversationRoutes = new Hono<AppEnv>();
conversationRoutes.use("*", requireProject);

// Penjaga per project: daftar & transkrip melakukan agregat, jadi dibatasi
// seperti endpoint pembuatan run. Pesannya sengaja berbeda karena ini pembacaan.
const limitConversationReads = createRateLimiter<AppEnv>({
  windowMs: env.rateLimitWindowMs,
  max: env.rateLimitRunsPerMin,
  key: (c) => `project:${c.get("project").id}`,
  message: "Too many history requests. Try again shortly.",
});

// Penjaga terpisah untuk mutasi (rename/hapus): operasi destruktif tidak perlu
// ikut menghabiskan jatah pembacaan, tapi tetap dibatasi per project.
const limitConversationWrites = createRateLimiter<AppEnv>({
  windowMs: env.rateLimitWindowMs,
  max: env.rateLimitRunsPerMin,
  key: (c) => `project:${c.get("project").id}`,
  message: "Too many history changes. Try again shortly.",
});

const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;
const DEFAULT_TURN_LIMIT = 50;
const MAX_TURN_LIMIT = 200;

// Status non-terminal: selama salah satunya ada, percakapan tidak boleh dihapus.
// Sisanya (SETTLED/RELEASED/INSUFFICIENT_BALANCE) sudah final dan aman ditinggal.
const ACTIVE_RUN_STATUSES: Array<(typeof runs.$inferSelect)["status"]> = [
  "CREATED",
  "AWAITING_CONFIRMATION",
  "RESERVED",
  "RUNNING",
];

const renameSchema = z.object({
  // Dipangkas dulu, baru diperiksa: judul berisi spasi saja sama saja kosong,
  // dan kolomnya `NULL`-able sehingga nilai hampa lebih baik ditolak 400.
  title: z.string().trim().min(1).max(80),
});

/**
 * Cari percakapan milik project ini; 404 (bukan 403) bila bukan miliknya supaya
 * keberadaan id milik project lain tidak bocor. Format id ikut diperiksa di
 * depan agar id yang tak pernah bisa dibuat server tidak menyentuh DB.
 */
async function findOwnedConversation(id: string, projectId: string) {
  if (!CONVERSATION_ID_PATTERN.test(id)) {
    throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
  }
  const found = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  const conversation = found[0];
  if (!conversation || conversation.projectId !== projectId) {
    throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
  }
  return conversation;
}

/** Daftar percakapan milik project, urut aktivitas terbaru. */
conversationRoutes.get("/", limitConversationReads, async (c) => {
  const project = c.get("project");
  const limit = parseLimit(c.req.query("limit"), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const cursor = readCursor(c.req.query("cursor"));
  // Pencarian opsional: judul ATAU isi prompt run. Polanya sudah diloloskan
  // (`readSearchPattern`), jadi `%` yang diketik user bukan wildcard.
  const search = readSearchPattern(c.req.query("q"));

  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      createdAt: conversations.createdAt,
      lastRunAt: sql<Date>`max(${runs.createdAt})`,
      runCount: sql<number>`count(${runs.id})::int`,
    })
    .from(conversations)
    // Inner join: percakapan tanpa run (run media di-`cancel` atau di-reap reaper)
    // tidak ditampilkan — entri riwayat yang membuka thread kosong lebih
    // membingungkan daripada tidak ada. `createRun` selalu menulis run di
    // transaksi yang sama, jadi percakapan "hidup" tidak pernah kosong.
    .innerJoin(runs, eq(runs.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.projectId, project.id),
        // Filter pencarian di WHERE (bukan HAVING) supaya baris run yang tidak
        // cocok dibuang LEBIH DULU. `EXISTS` sengaja memakai subquery terpisah,
        // bukan alias `runs` yang di-join: kalau memakai alias itu, `count` dan
        // `max` hanya menghitung run yang cocok sehingga `run_count`/kursor jadi
        // salah.
        search
          ? or(
              sql`${conversations.title} ILIKE ${search} ESCAPE '\\'`,
              exists(
                db
                  .select({ one: sql`1` })
                  .from(runs)
                  .where(
                    and(
                      eq(runs.conversationId, conversations.id),
                      sql`${runs.input} ILIKE ${search} ESCAPE '\\'`,
                    ),
                  ),
              ),
            )
          : undefined,
      ),
    )
    .groupBy(conversations.id)
    // Tiebreak `id` bukan cuma membuat urutan stabil, tapi juga membuat kursor
    // `(waktu, id)` tidak ambigu saat dua percakapan punya waktu aktivitas sama.
    .orderBy(desc(sql`max(${runs.createdAt})`), desc(conversations.id))
    .having(
      cursor
        ? sql`(max(${runs.createdAt}), ${conversations.id}) < (${cursor.at}::timestamptz, ${cursor.id}::text)`
        : sql`true`,
    )
    // `limit + 1` untuk tahu masih ada halaman berikutnya tanpa query hitung.
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  // Run SETTLED terbaru per percakapan + share aktifnya. History memakai ini
  // untuk tombol "Share latest" tanpa harus membuka transkrip lebih dulu.
  const pageIds = page.map((row) => row.id);
  const latestRuns = pageIds.length
    ? await db
        .selectDistinctOn([runs.conversationId], {
          conversationId: runs.conversationId,
          runId: runs.id,
          createdAt: runs.createdAt,
        })
        .from(runs)
        .where(and(inArray(runs.conversationId, pageIds), eq(runs.status, "SETTLED")))
        .orderBy(runs.conversationId, desc(runs.createdAt), desc(runs.id))
    : [];
  const latestByConversation = new Map(
    latestRuns.map((run) => [run.conversationId, run] as const),
  );
  const latestRunIds = latestRuns.map((run) => run.runId);
  const shares = latestRunIds.length
    ? await db
        .select()
        .from(runShares)
        .where(and(inArray(runShares.runId, latestRunIds), isNull(runShares.revokedAt)))
    : [];
  const shareByRun = new Map(shares.map((share) => [share.runId, share] as const));

  return c.json({
    conversations: page.map((row) => {
      const latest = latestByConversation.get(row.id);
      const share = latest ? shareByRun.get(latest.runId) : undefined;
      return {
        id: row.id,
        title: row.title,
        created_at: row.createdAt,
        last_run_at: row.lastRunAt,
        run_count: Number(row.runCount),
        latest_settled_run_id: latest?.runId ?? null,
        share: share
          ? {
              slug: share.slug,
              show_prompt: share.showPrompt,
              created_at: share.createdAt,
            }
          : null,
      };
    }),
    has_more: hasMore,
    next_cursor: hasMore && last ? `${new Date(last.lastRunAt).toISOString()}|${last.id}` : null,
  });
});

/** Transkrip satu percakapan: turn urut naik + langkah tiap run. */
conversationRoutes.get("/:id", limitConversationReads, async (c) => {
  const project = c.get("project");
  const id = c.req.param("id");
  const limit = parseLimit(c.req.query("limit"), DEFAULT_TURN_LIMIT, MAX_TURN_LIMIT);
  // Kursor divalidasi SEBELUM kepemilikan diperiksa: permintaan dengan kursor
  // rusak selalu 400, terlepas dari id-nya ada atau tidak (kontrak paginasi).
  // `before` mengambil turn yang lebih lama dari turn kursor (lihat readCursor).
  const cursor = readCursor(c.req.query("before"));
  const conversation = await findOwnedConversation(id, project.id);

  // Ambil `limit + 1` baris agar tahu masih ada yang lebih lama tanpa query hitung.
  const rows = await db
    .select()
    .from(runs)
    .where(
      cursor
        ? and(
            eq(runs.conversationId, id),
            sql`(${runs.createdAt}, ${runs.id}) < (${cursor.at}::timestamptz, ${cursor.id}::text)`,
          )
        : eq(runs.conversationId, id),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const newestPage = hasMore ? rows.slice(0, limit) : rows;
  // Baris terakhir dalam urutan DB (menurun) adalah turn TERLAMA di halaman ini
  // → dialah kursor halaman berikutnya. Dihitung sebelum `reverse()` karena
  // kursor mengikuti urutan `(created_at, id)` menurun.
  const oldestInPage = newestPage[newestPage.length - 1];
  const page = newestPage.reverse();

  // Satu query untuk semua langkah (hindari N+1).
  const ids = page.map((run) => run.id);
  const steps = ids.length
    ? await db.select().from(runSteps).where(inArray(runSteps.runId, ids))
    : [];

  return c.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      created_at: conversation.createdAt,
    },
    turns: page.map((run) => serializeRun(run, steps.filter((step) => step.runId === run.id))),
    has_more: hasMore,
    next_cursor:
      hasMore && oldestInPage ? `${oldestInPage.createdAt.toISOString()}|${oldestInPage.id}` : null,
  });
});

/**
 * Ganti judul percakapan.
 *
 * Hanya judul yang bisa diubah — transkrip dibangun ulang dari `runs`, jadi
 * tidak ada salinan teks yang perlu disinkronkan. Judul ini yang tampil di
 * halaman History (ChatView tidak menampilkan judul).
 */
conversationRoutes.patch("/:id", limitConversationWrites, async (c) => {
  const project = c.get("project");
  const id = c.req.param("id");
  await findOwnedConversation(id, project.id);
  const body = renameSchema.parse(await c.req.json());

  const updated = await db
    .update(conversations)
    .set({ title: body.title })
    .where(eq(conversations.id, id))
    .returning({ id: conversations.id, title: conversations.title, createdAt: conversations.createdAt });

  const row = updated[0];
  if (!row) {
    throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
  }
  return c.json({
    conversation: { id: row.id, title: row.title, created_at: row.createdAt },
  });
});

/**
 * Hapus percakapan (hard delete).
 *
 * `messages` ikut terhapus lewat `onDelete: cascade`. Baris `runs` SENGAJA
 * dipertahankan karena dipakai billing/usage/ledger — yang dilepas hanya
 * tautannya (`conversation_id` → NULL), sehingga run tetap bisa diaudit sebagai
 * run tanpa percakapan (sama seperti jalur API stateless).
 *
 * Ditolak 409 selama masih ada run aktif: menghapus di tengah eksekusi akan
 * mencabut konteks yang sedang dipakai runner. Diperiksa di dalam transaksi agar
 * balapan dengan `createRun` (yang juga bertransaksi) tidak meloloskan run baru.
 */
conversationRoutes.delete("/:id", limitConversationWrites, async (c) => {
  const project = c.get("project");
  const id = c.req.param("id");
  await findOwnedConversation(id, project.id);

  const releasedRuns = await db.transaction(async (tx) => {
    const active = await tx
      .select({ one: sql`1` })
      .from(runs)
      .where(and(eq(runs.conversationId, id), inArray(runs.status, ACTIVE_RUN_STATUSES)))
      .limit(1);
    if (active.length > 0) {
      throw new ApiError(
        409,
        "CONVERSATION_ACTIVE",
        "This chat has a run in progress. Wait for it to finish, then delete it.",
      );
    }

    // Run dipertahankan untuk billing, jadi share-nya harus dicabut eksplisit.
    await revokeSharesForConversation(tx, project.id, id);

    const released = await tx
      .update(runs)
      .set({ conversationId: null })
      .where(eq(runs.conversationId, id))
      .returning({ id: runs.id });
    await tx.delete(conversations).where(eq(conversations.id, id));
    return released.length;
  });

  // Jejak audit: id + jumlah run yang dilepas, TANPA isi prompt.
  console.log(`[conversations] delete id=${id} project=${project.id} released_runs=${releasedRuns}`);

  return c.body(null, 204);
});
