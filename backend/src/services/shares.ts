import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "../billing/ledger";
import { db } from "../db";
import { runShares, runSteps, runs } from "../db/schema";
import { ApiError } from "../lib/http";
import { newId, newShareSlug, SHARE_SLUG_PATTERN } from "../lib/id";

export type RunShareRow = typeof runShares.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunStepRow = typeof runSteps.$inferSelect;

export interface SharedRun {
  share: RunShareRow;
  run: RunRow;
  steps: RunStepRow[];
}

/** URL publik kanonis untuk satu slug. */
export function shareUrl(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/run/${slug}`;
}

/** Share aktif milik satu run (null bila belum pernah dibuat/dicabut). */
export async function getActiveShareForRun(runId: string): Promise<RunShareRow | null> {
  const rows = await db
    .select()
    .from(runShares)
    .where(and(eq(runShares.runId, runId), isNull(runShares.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Ambil share aktif + run + langkahnya untuk endpoint publik.
 *
 * Slug yang bentuknya tidak sah langsung dianggap tidak ada supaya request
 * sampah tidak menyentuh DB. Revoked dan tidak-ada sengaja menghasilkan `null`
 * yang sama — jangan bocorkan bahwa sebuah tautan pernah aktif.
 */
export async function getPublicSharedRun(slug: string): Promise<SharedRun | null> {
  if (!SHARE_SLUG_PATTERN.test(slug)) return null;

  const rows = await db
    .select({ share: runShares, run: runs })
    .from(runShares)
    .innerJoin(runs, eq(runShares.runId, runs.id))
    .where(
      and(
        eq(runShares.slug, slug),
        isNull(runShares.revokedAt),
        eq(runs.status, "SETTLED"),
      ),
    )
    .limit(1);

  const found = rows[0];
  if (!found) return null;

  const steps = await db
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, found.run.id))
    .orderBy(asc(runSteps.createdAt), asc(runSteps.id));
  return { share: found.share, run: found.run, steps };
}

/**
 * Buat share baru atau segarkan share aktif yang sudah ada.
 *
 * - Share aktif → slug tetap (tautan yang sudah disebar tidak mati hanya karena
 *   toggle prompt diubah).
 * - Share yang pernah dicabut → slug BARU, supaya tautan lama tetap mati.
 * - Run non-SETTLED ditolak: halaman publik hanya untuk hasil final.
 */
export async function createOrRefreshShare(input: {
  run: RunRow;
  projectId: string;
  /** Omitted = pertahankan nilai share aktif, atau default tampil untuk share baru. */
  showPrompt?: boolean;
}): Promise<RunShareRow> {
  if (input.run.status !== "SETTLED") {
    throw new ApiError(400, "RUN_NOT_SETTLED", "Only settled runs can be shared.");
  }

  const existing = await db
    .select()
    .from(runShares)
    .where(eq(runShares.runId, input.run.id))
    .limit(1);
  const current = existing[0];

  if (current && !current.revokedAt) {
    if (input.showPrompt === undefined) return current;
    const updated = await db
      .update(runShares)
      .set({ showPrompt: input.showPrompt })
      .where(eq(runShares.id, current.id))
      .returning();
    return updated[0] ?? current;
  }

  if (current) {
    const refreshed = await db
      .update(runShares)
      .set({
        slug: newShareSlug(),
        showPrompt: input.showPrompt ?? true,
        revokedAt: null,
        createdAt: new Date(),
      })
      .where(eq(runShares.id, current.id))
      .returning();
    return refreshed[0] ?? current;
  }

  try {
    const inserted = await db
      .insert(runShares)
      .values({
        id: newId("share"),
        runId: input.run.id,
        projectId: input.projectId,
        slug: newShareSlug(),
        showPrompt: input.showPrompt ?? true,
      })
      .returning();
    return inserted[0];
  } catch {
    // Balapan dua request share untuk run yang sama: unique(run_id) membuat
    // satu kalah. Baca pemenangnya alih-alih mengembalikan 500.
    const winner = await getActiveShareForRun(input.run.id);
    if (!winner) throw new ApiError(500, "SHARE_CREATE_FAILED", "Could not create share link.");
    return winner;
  }
}

/** Cabut share aktif satu run. Mengembalikan false bila memang tidak ada. */
export async function revokeRunShare(projectId: string, runId: string): Promise<boolean> {
  const revoked = await db
    .update(runShares)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(runShares.projectId, projectId),
        eq(runShares.runId, runId),
        isNull(runShares.revokedAt),
      ),
    )
    .returning({ id: runShares.id });
  return revoked.length > 0;
}

/**
 * Saat percakapan dihapus, cabut share run-run di dalamnya. Run sendiri
 * dipertahankan untuk billing, jadi tanpa langkah ini tautan publik akan tetap
 * hidup padahal pemiliknya sudah menghapus percakapan.
 */
export async function revokeSharesForConversation(
  tx: Tx,
  projectId: string,
  conversationId: string,
): Promise<void> {
  const runIds = tx
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.conversationId, conversationId));
  await tx
    .update(runShares)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(runShares.projectId, projectId),
        isNull(runShares.revokedAt),
        inArray(runShares.runId, runIds),
      ),
    );
}
