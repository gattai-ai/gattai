import { and, desc, eq, lte, notExists, notInArray, sql } from "drizzle-orm";
import { getParams } from "../config";
import { db } from "../db";
import { conversations, messages, runs } from "../db/schema";
import { ApiError } from "../lib/http";
import { newId } from "../lib/id";
import { KEEP_RECENT_MESSAGES, summarizeHistory } from "../orchestration/summarize";
import type { ChatMessage } from "../providers";
import type { Tx } from "../billing/ledger";

/**
 * Percakapan server-side: mengelompokkan run (`conversation_id` dari klien),
 * menyimpan pesan user+assistant untuk konteks, dan memelihara ringkasan
 * rolling agar biaya konteks tidak tumbuh tanpa batas (brief §5.3).
 *
 * Penyimpanan tidak pernah menggagalkan billing: dipanggil setelah settle,
 * dan kegagalan dicatat sebagai warning oleh pemanggil.
 */

export type ConversationRow = typeof conversations.$inferSelect;

/**
 * Bentuk id percakapan yang sah: `conv_` + 32 hex (`newId("conv")`). Id dibuat
 * server, jadi klien hanya boleh meneruskan id yang pernah dikirim server.
 */
export const CONVERSATION_ID_PATTERN = /^conv_[0-9a-f]{32}$/;

function titleFromInput(input: string): string {
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat || "New chat";
}

/** Eksekutor query: koneksi global atau transaksi yang sedang berjalan. */
type Executor = Tx | typeof db;

/**
 * Verifikasi kepemilikan. `conversations.id` adalah primary key GLOBAL, jadi id
 * yang sah milik project lain harus ditolak dengan 409 — bukan 500 — supaya
 * klien tahu harus membuang id itu dan mulai chat baru.
 */
function assertOwnership(row: ConversationRow, projectId: string): ConversationRow {
  if (row.projectId !== projectId) {
    throw new ApiError(
      409,
      "CONVERSATION_ID_TAKEN",
      "This conversation id is already used by another account. Start a new chat.",
    );
  }
  return row;
}

/**
 * Ambil atau buat baris conversation (scoped per project).
 *
 * Insert memakai `onConflictDoNothing` lalu baca ulang: dua turn bersamaan untuk
 * chat yang sama sama-sama lolos pemeriksaan awal, dan tanpa ini yang kalah akan
 * gagal karena primary key (`conversations.id`) — bukan sekadar mengulang.
 * Pola yang sama dipakai `services/projects.ts` untuk balapan `owner_wallet`.
 */
export async function ensureConversation(
  projectId: string,
  clientKey: string,
  titleSeed: string,
  executor: Executor = db,
): Promise<ConversationRow> {
  const existing = await executor
    .select()
    .from(conversations)
    .where(eq(conversations.id, clientKey))
    .limit(1);
  if (existing[0]) return assertOwnership(existing[0], projectId);

  await executor
    .insert(conversations)
    .values({ id: clientKey, projectId, title: titleFromInput(titleSeed) })
    .onConflictDoNothing({ target: conversations.id });

  const reread = await executor
    .select()
    .from(conversations)
    .where(eq(conversations.id, clientKey))
    .limit(1);
  const row = reread[0];
  if (!row) {
    throw new ApiError(500, "CONVERSATION_CREATE_FAILED", "Failed to open the conversation. Try again.");
  }
  return assertOwnership(row, projectId);
}

/**
 * Konteks untuk run BERIKUTNYA: ringkasan rolling + N pesan terakhir (urut naik).
 *
 * Server adalah sumber kebenaran konteks. `messages` memuat SEMUA turn
 * percakapan, sedangkan klien hanya memegang yang sudah dimuat di layarnya
 * (setelah reload atau paginasi, turn lama tidak ada di memori). Jendela
 * `windowMessages` mencegah percakapan panjang mengirim transkrip penuh ke
 * provider pada setiap turn; sisanya sudah terwakili `summary`.
 */
export async function getConversationContext(
  projectId: string,
  conversationId: string,
  windowMessages: number,
): Promise<{ summary: string | null; messages: ChatMessage[] }> {
  const owner = await db
    .select({ projectId: conversations.projectId, summary: conversations.summary })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (owner[0]?.projectId !== projectId) return { summary: null, messages: [] };

  // Ambil dari yang TERBARU supaya `limit` memotong turn tertua, lalu balik
  // lagi agar urutan kronologis untuk provider.
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(windowMessages);

  return {
    summary: owner[0].summary,
    messages: rows.reverse() as ChatMessage[],
  };
}

/** Tambahkan pesan user (+assistant bila ada output) yang terhubung ke run. */
export async function appendRunMessages(input: {
  projectId: string;
  conversationId: string;
  runId: string;
  userContent: string;
  assistantContent: string | null;
}): Promise<void> {
  // `created_at` diisi eksplisit dan menaik. Pasangan user+assistant ditulis
  // dalam SATU statement, jadi `default now()` memberi waktu identik untuk
  // keduanya — sedangkan tiebreaker `id` acak (`newId`) sehingga urutan bacanya
  // tidak deterministik dan ringkasan bisa melihat jawaban sebelum pertanyaan.
  const base = Date.now();
  const rows: Array<typeof messages.$inferInsert> = [
    {
      id: newId("msg"),
      conversationId: input.conversationId,
      role: "user",
      content: input.userContent,
      createdAt: new Date(base),
    },
  ];
  if (input.assistantContent) {
    rows.push({
      id: newId("msg"),
      conversationId: input.conversationId,
      role: "assistant",
      content: input.assistantContent,
      runId: input.runId,
      createdAt: new Date(base + 1),
    });
  }
  await db.insert(messages).values(rows);
}

/**
 * Segarkan ringkasan rolling bila total konten baru melewati ambang.
 *
 * Ringkasan lama ikut dirangkum: setelah turn yang sudah diringkas dipangkas
 * dari `messages` (lihat di bawah), transkrip di tabel tidak lagi memuat awal
 * percakapan. Mengembalikan biaya provider (USD) bila ringkasan dijalankan,
 * agar dapat dibebankan ke run yang memicunya.
 */
export async function maybeRefreshSummary(
  projectId: string,
  conversationId: string,
  thresholdChars?: number,
): Promise<{ summary: string | null; costUsd: number }> {
  const threshold =
    thresholdChars ?? getParams().context.summary_threshold_chars;
  // Verifikasi kepemilikan via conversation. `summary` ikut dibaca karena
  // ringkasan lama harus dijadikan bahan ringkasan berikutnya.
  const owner = await db
    .select({ projectId: conversations.projectId, summary: conversations.summary })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (owner[0]?.projectId !== projectId) {
    return { summary: null, costUsd: 0 };
  }

  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt, messages.id);
  const pending = rows as Array<ChatMessage & { id: string; createdAt: Date }>;
  const total = pending.reduce((sum, message) => sum + message.content.length, 0);
  if (total < threshold) {
    return { summary: null, costUsd: 0 };
  }

  const previous = owner[0].summary;
  const history: ChatMessage[] = previous
    ? [{ role: "system", content: `Summary of earlier conversation:\n${previous}` }, ...pending]
    : pending;

  const result = await summarizeHistory(history, { thresholdChars: threshold });
  if (!result.summarized || !result.summary) {
    return { summary: null, costUsd: result.providerCostUsd };
  }

  await db
    .update(conversations)
    .set({ summary: result.summary })
    .where(eq(conversations.id, conversationId));

  // Pemangkasan konteks: turn yang sudah masuk ringkasan tidak perlu disimpan
  // selamanya. Hanya ekor verbatim yang disisakan. Transkrip UI dibangun dari
  // `runs`, jadi ini tidak menghapus riwayat yang dilihat user. Batas
  // `created_at` melindungi pesan yang ditulis run lain SETELAH pembacaan di
  // atas — pesan itu belum masuk ringkasan ini.
  const lastSummarized = pending[pending.length - 1];
  if (pending.length > KEEP_RECENT_MESSAGES && lastSummarized) {
    const keep = pending.slice(-KEEP_RECENT_MESSAGES).map((message) => message.id);
    await db
      .delete(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          lte(messages.createdAt, lastSummarized.createdAt),
          notInArray(messages.id, keep),
        ),
      );
  }

  return { summary: result.summary, costUsd: result.providerCostUsd };
}

/**
 * Hapus percakapan yang sudah tidak punya run sama sekali.
 *
 * Dipakai setelah run TERAKHIRNYA hilang — dibatalkan klien
 * (`POST /v1/runs/:id/cancel`) atau kedaluwarsa di tangan reaper. Percakapan
 * tanpa run tidak muncul di riwayat (daftar memakai inner join ke `runs`) dan
 * tidak bisa dibuka secara bermakna, jadi barisnya jangan menggantung. Pesannya
 * ikut terhapus lewat `onDelete: cascade`.
 *
 * Satu statement dengan subquery `NOT EXISTS` supaya balapan dengan request lain
 * yang membuka percakapan itu lagi tidak menghapus percakapan yang sudah terisi.
 */
export async function dropConversationIfEmpty(conversationId: string | null): Promise<void> {
  if (!conversationId) return;
  await db
    .delete(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        notExists(
          db.select({ one: sql`1` }).from(runs).where(eq(runs.conversationId, conversationId)),
        ),
      ),
    );
}
