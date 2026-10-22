import { eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { projects } from "../db/schema";
import { newId } from "../lib/id";
import { onchainProjectId } from "../onchain/project-id";

export type Project = typeof projects.$inferSelect;

export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

/** Cari project milik wallet, buat jika belum ada (login SIWE pertama). */
export async function findOrCreateProjectByWallet(address: string): Promise<Project> {
  const wallet = normalizeAddress(address);
  const existing = await db
    .select()
    .from(projects)
    .where(eq(projects.ownerWallet, wallet))
    .limit(1);
  if (existing[0]) {
    // Backfill onchain_id untuk project lama yang belum punya.
    if (!existing[0].onchainId) return backfillOnchainId(existing[0]);
    return existing[0];
  }

  const id = newId("prj");
  try {
    const inserted = await db
      .insert(projects)
      .values({
        id,
        name: `Project ${address.slice(0, 6)}…${address.slice(-4)}`,
        ownerWallet: wallet,
        onchainId: onchainProjectId(id),
      })
      .returning();

    return inserted[0];
  } catch {
    // Balapan dua login SIWE untuk wallet yang sama: `owner_wallet` UNIQUE,
    // sehingga yang kalah membaca ulang baris pemenang alih-alih gagal 500.
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.ownerWallet, wallet))
      .limit(1);
    if (rows[0]) return rows[0];
    throw new Error(`Failed to create a project for wallet ${wallet}`);
  }
}

export async function getProjectById(id: string): Promise<Project | undefined> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0];
}

async function backfillOnchainId(project: Project): Promise<Project> {
  const updated = await db
    .update(projects)
    .set({ onchainId: onchainProjectId(project.id) })
    .where(eq(projects.id, project.id))
    .returning();
  return updated[0] ?? project;
}

/**
 * Isi `onchain_id` untuk semua project yang belum punya (idempoten).
 * Dipanggil saat boot agar deposit lama/seed tetap bisa dipetakan indexer.
 */
export async function ensureProjectOnchainIds(): Promise<number> {
  const missing = await db.select().from(projects).where(isNull(projects.onchainId));
  for (const project of missing) {
    await db
      .update(projects)
      .set({ onchainId: onchainProjectId(project.id) })
      .where(eq(projects.id, project.id));
  }
  return missing.length;
}
