import { eq } from "drizzle-orm";
import { db } from "../db";
import { chainCursors } from "../db/schema";

/**
 * Kursor rantai persisten (P1.1).
 *
 * Kursor disimpan di DB supaya restart proses (termasuk `bun --watch` saat
 * pengembangan) tidak men-scan ulang dari `INDEXER_FROM_BLOCK` — yang bisa
 * puluhan ribu blok dan memicu rate-limit RPC.
 *
 * Nomor blok <= 2^53 sehingga aman disimpan sebagai `number` (kolom bigint).
 */
export async function loadCursor(name: string): Promise<bigint | null> {
  const rows = await db
    .select({ blockNumber: chainCursors.blockNumber })
    .from(chainCursors)
    .where(eq(chainCursors.name, name))
    .limit(1);
  if (!rows[0]) return null;
  return BigInt(rows[0].blockNumber);
}

export async function saveCursor(name: string, blockNumber: bigint): Promise<void> {
  const value = Number(blockNumber);
  await db
    .insert(chainCursors)
    .values({ name, blockNumber: value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: chainCursors.name,
      set: { blockNumber: value, updatedAt: new Date() },
    });
}
