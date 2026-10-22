import { and, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { conversations, messages, runs } from "../db/schema";

/**
 * Backfill tautan percakapan lama (`runs.conversation_id`).
 *
 * Fase C menambahkan `runs.conversation_id`, tetapi run yang dibuat sebelum itu
 * tidak punya tautan. Satu-satunya sumber untuk memulihkannya adalah `messages`:
 * pesan assistant mencatat `run_id` dan berada di dalam percakapan yang benar.
 * Karena `messages` dipangkas oleh ringkasan rolling, backfill ini harus
 * dijalankan SEBELUM pemangkasan menghapus pesannya (lihat docs/10-runbook).
 *
 * Aman diulang (idempoten): hanya run dengan `conversation_id IS NULL` yang
 * disentuh. Batched agar tidak menahan lock tabel besar dalam satu statement.
 * Baris `runs` yang pesannya menunjuk percakapan project LAIN (data korup) tidak
 * ditautkan, melainkan dilaporkan sebagai konflik.
 */

/** Jumlah run per batch; cukup kecil untuk lock pendek. */
export const DEFAULT_BATCH_SIZE = 500;

/** Batas loop, jaring pengaman bila data berubah terus saat proses berjalan. */
const MAX_BATCHES = 100_000;

export interface BackfillOptions {
  /** `true` (default): hanya menghitung, tidak menulis apa pun. */
  dryRun?: boolean;
  /** Jumlah run per batch. Default `DEFAULT_BATCH_SIZE`. */
  batchSize?: number;
  /** Batasi ke satu project (opsional). */
  projectId?: string;
}

export interface BackfillLink {
  runId: string;
  conversationId: string;
  projectId: string;
}

export interface BackfillReport {
  dryRun: boolean;
  /** Run yang ditautkan (apply) atau akan ditautkan (dry-run). */
  linked: number;
  /** Jumlah batch write yang dijalankan (0 saat dry-run). */
  batches: number;
  /** Run dengan pesan lintas project; tidak ditautkan. */
  conflicts: number;
  /** Contoh run yang berkonflik, untuk ditindak manual. */
  conflictSamples: string[];
  /** Tautan yang dibuat (untuk rollback manual); kosong saat dry-run. */
  links: BackfillLink[];
}

/**
 * Subquery kandidat: satu baris per run yang bisa ditautkan, beserta percakapan
 * tujuan. `min()` membuat pilihan deterministik seandainya (karena data korup)
 * ada lebih dari satu percakapan satu-project yang menunjuk run ini.
 */
function candidateQuery(projectId?: string): SQL {
  return sql`
    SELECT r2.id AS run_id, min(m.conversation_id) AS conversation_id
    FROM runs r2
    JOIN messages m ON m.run_id = r2.id
    JOIN conversations c ON c.id = m.conversation_id AND c.project_id = r2.project_id
    WHERE r2.conversation_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM messages m2
        JOIN conversations c2 ON c2.id = m2.conversation_id
        WHERE m2.run_id = r2.id AND c2.project_id <> r2.project_id
      )
      ${projectId ? sql`AND r2.project_id = ${projectId}` : sql``}
    GROUP BY r2.id
  `;
}

/** Jumlah run yang akan ditautkan (untuk mode dry-run). */
async function countCandidates(projectId?: string): Promise<number> {
  const result = await db.execute(
    sql`SELECT count(*)::int AS count FROM (${candidateQuery(projectId)}) AS cand`,
  );
  const rows = result.rows as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}

/** Jalankan satu batch `UPDATE`; kembalikan tautan yang dibuat di batch ini. */
async function applyBatch(batchSize: number, projectId?: string): Promise<BackfillLink[]> {
  const result = await db.execute(
    sql`
      UPDATE runs AS r
      SET conversation_id = cand.conversation_id
      FROM (${candidateQuery(projectId)} LIMIT ${batchSize}) AS cand
      WHERE r.id = cand.run_id AND r.conversation_id IS NULL
      RETURNING r.id, r.conversation_id, r.project_id
    `,
  );
  const rows = result.rows as Array<{ id: string; conversation_id: string; project_id: string }>;
  return rows.map((row) => ({
    runId: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
  }));
}

/** Run yang pesannya menunjuk percakapan milik project lain (anomali data). */
async function selectConflicts(
  projectId?: string,
): Promise<Array<{ runId: string; projectId: string }>> {
  return db
    .select({ runId: runs.id, projectId: runs.projectId })
    .from(runs)
    .innerJoin(messages, eq(messages.runId, runs.id))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        isNull(runs.conversationId),
        ne(conversations.projectId, runs.projectId),
        projectId ? eq(runs.projectId, projectId) : undefined,
      ),
    )
    .groupBy(runs.id, runs.projectId);
}

/** Jalankan backfill; `dryRun` default `true` supaya salah pakai tidak merusak. */
export async function backfillConversations(
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const dryRun = options.dryRun ?? true;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const projectId = options.projectId;

  const conflicts = await selectConflicts(projectId);
  const conflictSamples = conflicts
    .slice(0, 20)
    .map((row) => `${row.runId} (project ${row.projectId})`);

  if (dryRun) {
    const linked = await countCandidates(projectId);
    return { dryRun: true, linked, batches: 0, conflicts: conflicts.length, conflictSamples, links: [] };
  }

  const links: BackfillLink[] = [];
  let batches = 0;
  while (batches < MAX_BATCHES) {
    const batch = await applyBatch(batchSize, projectId);
    if (batch.length === 0) break;
    batches += 1;
    links.push(...batch);
    // Batch terakhir biasanya lebih kecil dari `batchSize` → berhenti tanpa
    // query kosong tambahan.
    if (batch.length < batchSize) break;
  }

  return {
    dryRun: false,
    linked: links.length,
    batches,
    conflicts: conflicts.length,
    conflictSamples,
    links,
  };
}
