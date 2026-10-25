import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  getHolderSnapshotRetentionDays,
  getHolderSnapshotRetentionMinPerWallet,
} from "./config";

/**
 * Hapus snapshot lama tanpa menghilangkan riwayat minimum per wallet.
 *
 * Kebijakan: baris yang lebih tua dari `retentionDays` dihapus, tetapi
 * `minPerWallet` snapshot terbaru per wallet selalu dipertahankan. Dengan
 * begitu tabel tidak tumbuh tanpa batas, sementara audit tier tetap punya
 * cukup data.
 */
export async function pruneHolderSnapshots(options: {
  retentionDays?: number;
  minPerWallet?: number;
  now?: Date;
} = {}): Promise<number> {
  const retentionDays = options.retentionDays ?? getHolderSnapshotRetentionDays();
  const minPerWallet =
    options.minPerWallet ?? getHolderSnapshotRetentionMinPerWallet();

  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error("retentionDays must be a positive integer.");
  }
  if (!Number.isInteger(minPerWallet) || minPerWallet < 2) {
    throw new Error("minPerWallet must be an integer >= 2.");
  }

  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  // Ranking hanya dilakukan pada baris lama. Snapshot baru tidak pernah
  // disentuh, dan minimal N snapshot lama terbaru tetap disimpan.
  const result = await db.execute(sql`
    WITH old AS (
      SELECT
        id,
        row_number() OVER (
          PARTITION BY wallet
          ORDER BY taken_at DESC, block_number DESC
        ) AS rn
      FROM holder_snapshots
      WHERE taken_at < ${cutoff}
    )
    DELETE FROM holder_snapshots hs
    USING old
    WHERE hs.id = old.id
      AND old.rn > ${minPerWallet}
    RETURNING hs.id
  `);

  return result.rows.length;
}
