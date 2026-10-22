import { and, eq, gte, isNull, or } from "drizzle-orm";
import type { PublicClient } from "viem";
import { recordCreditLotTx, reverseCredit } from "../billing/ledger";
import { db } from "../db";
import { deposits } from "../db/schema";
import { recordDeadLetter } from "./dead-letter";
import { isReceiptNotFound } from "./errors";

/** Penyimpan hitungan "receipt hilang" per deposit; reset saat receipt kembali. */
const defaultMissCounts = new Map<string, number>();

export interface ReorgDeps {
  client: Pick<PublicClient, "getTransactionReceipt">;
  /** Kedalaman blok yang diperiksa: deposit dengan `blockNumber >= head - lookback`. */
  lookbackBlocks: bigint;
  /** Jumlah pemeriksaan beruntun tanpa receipt sebelum dianggap hilang. Default 2. */
  missThreshold?: number;
  /** Batas deposit yang diperiksa per pass. Default 500. */
  limit?: number;
  /** Peta hitungan (untuk tes); default state internal modul. */
  missCounts?: Map<string, number>;
  onFlag?: (info: {
    depositId: string;
    chainTx: string;
    logIndex: number;
    reason: string;
  }) => void;
  onRepair?: (info: {
    depositId: string;
    chainTx: string;
    logIndex: number;
    oldBlock: number | null;
    newBlock: number;
  }) => void;
}

export interface ReorgCheckResult {
  checked: number;
  repaired: number;
  restored: number;
  flagged: number;
}

/**
 * Penjaga reorg (P0.3).
 *
 * Untuk deposit `confirmed` di dalam jendela `lookbackBlocks` (atau yang
 * block metadata-nya masih NULL), dan semua deposit `reorged`:
 *  - receipt ada & hash blok sama  → aman.
 *  - receipt ada & hash blok beda  → **inklusi ulang**: tx masih sah, hanya
 *    pindah blok; perbaiki `blockNumber`/`blockHash`. Saldo TIDAK diubah.
 *  - receipt hilang (>= `missThreshold` kali beruntun) → tarik kembali kredit
 *    (ledger ADJUST negatif + lot dikurangi), tandai `reorged`, dan catat
 *    dead-letter. Ini membuat kredit yang belum tentu ada tidak bisa dipakai.
 *  - deposit `reorged` yang receipt-nya muncul lagi → buat lot pengganti dan
 *    tandai `confirmed` kembali. Idempoten per tx/log/block.
 *
 * Penarikan dan pemulihan kredit memakai idempotency key yang mengandung
 * block hash, sehingga siklus hilang → muncul → hilang lagi tidak saling
 * menimpa.
 */
export async function reconcileReorgs(
  head: bigint,
  deps: ReorgDeps,
): Promise<ReorgCheckResult> {
  const minBlock = head > deps.lookbackBlocks ? head - deps.lookbackBlocks : 0n;
  const misses = deps.missCounts ?? defaultMissCounts;
  const missThreshold = deps.missThreshold ?? 2;

  const rows = await db
    .select({
      id: deposits.id,
      projectId: deposits.projectId,
      chainTx: deposits.chainTx,
      logIndex: deposits.logIndex,
      blockNumber: deposits.blockNumber,
      blockHash: deposits.blockHash,
      creditsMicro: deposits.creditsMicro,
      lotId: deposits.lotId,
      source: deposits.source,
      status: deposits.status,
    })
    .from(deposits)
    .where(
      or(
        and(
          eq(deposits.status, "confirmed"),
          or(
            gte(deposits.blockNumber, Number(minBlock)),
            // Backfill baris lama yang dikreditkan lewat jalur confirm sebelum
            // metadata blok ikut disimpan.
            isNull(deposits.blockNumber),
          ),
        ),
        // Deposit yang sudah ditarik tetap dipantau di luar jendela lookback:
        // bila tx muncul lagi, kreditnya harus bisa dipulihkan.
        eq(deposits.status, "reorged"),
      ),
    )
    .limit(deps.limit ?? 500);

  let repaired = 0;
  let restored = 0;
  let flagged = 0;

  for (const row of rows) {
    let receipt: { blockNumber: bigint; blockHash: string | null } | null;
    try {
      receipt = await deps.client.getTransactionReceipt({ hash: row.chainTx as `0x${string}` });
    } catch (error) {
      // Hanya "receipt tidak ditemukan" yang boleh dihitung sebagai miss.
      // Timeout/rate-limit/5xx adalah gangguan RPC sementara: jangan pernah
      // menandai deposit hilang karena itu.
      if (!isReceiptNotFound(error)) continue;
      receipt = null;
    }

    if (receipt) {
      misses.delete(row.id);

      // Deposit yang sebelumnya hilang sekarang muncul lagi. Pulihkan kredit
      // dengan lot baru; lot lama sudah dikurangi saat penarikan.
      if (row.status === "reorged") {
        if (row.creditsMicro > 0 && !row.source) {
          // Data lama/tidak lengkap: jangan menebak sumber lot. Biarkan
          // needs-review manual, tetapi jangan diam-diam menambah saldo.
          console.error(
            `[reorg] deposit ${row.id} reorged tanpa source; pemulihan otomatis dilewati`,
          );
          continue;
        }

        await db.transaction(async (tx) => {
          let lotId = row.lotId;
          if (row.creditsMicro > 0 && row.source) {
            const restoredLot = await recordCreditLotTx(tx, {
              projectId: row.projectId,
              source: row.source,
              amountMicro: row.creditsMicro,
              // `row.lotId` membuat key berbeda untuk siklus restore berikutnya
              // (lot baru), sementara retry pada siklus yang sama tetap idempoten.
              idempotencyKey: `reorg-restore:${row.chainTx}:${row.logIndex}:${
                receipt.blockHash ?? receipt.blockNumber
              }:${row.lotId ?? "no-lot"}`,
              depositTx: row.chainTx,
            });
            lotId = restoredLot.lotId ?? lotId;
          }

          await tx
            .update(deposits)
            .set({
              status: "confirmed",
              blockNumber: Number(receipt.blockNumber),
              blockHash: receipt.blockHash ?? null,
              lotId,
            })
            .where(eq(deposits.id, row.id));
        });

        restored += 1;
        deps.onRepair?.({
          depositId: row.id,
          chainTx: row.chainTx,
          logIndex: row.logIndex,
          oldBlock: row.blockNumber,
          newBlock: Number(receipt.blockNumber),
        });
        continue;
      }

      const sameHash =
        !row.blockHash ||
        !receipt.blockHash ||
        receipt.blockHash.toLowerCase() === row.blockHash.toLowerCase();
      const newBlock = Number(receipt.blockNumber);
      if (!sameHash || newBlock !== row.blockNumber) {
        await db
          .update(deposits)
          .set({ blockNumber: newBlock, blockHash: receipt.blockHash ?? null })
          .where(eq(deposits.id, row.id));
        repaired += 1;
        deps.onRepair?.({
          depositId: row.id,
          chainTx: row.chainTx,
          logIndex: row.logIndex,
          oldBlock: row.blockNumber,
          newBlock,
        });
      }
      continue;
    }

    // Deposit yang sudah `reorged` dan tetap hilang tidak perlu ditandai lagi.
    // Tetap coba catat dead-letter: kegagalan pencatatan sebelumnya tidak boleh
    // membuat deposit hilang dari antrean operator.
    if (row.status === "reorged") {
      await recordDeadLetter({
        chainTx: row.chainTx,
        logIndex: row.logIndex,
        error: `reorg: tx ${row.chainTx} masih tidak ada di rantai kanonik (blok ${row.blockNumber})`,
        attempts: misses.get(row.id) ?? 0,
      });
      continue;
    }

    const count = (misses.get(row.id) ?? 0) + 1;
    misses.set(row.id, count);
    if (count < missThreshold) continue;

    const reason = `reorg: tx ${row.chainTx} tidak ada lagi di rantai kanonik (blok ${row.blockNumber})`;

    // Tarik kredit sebelum menandai status. Bila proses mati di antara dua
    // langkah ini, pass berikutnya akan mengulang reverseCredit (idempotent)
    // lalu menandai status.
    if (row.creditsMicro > 0) {
      await reverseCredit({
        projectId: row.projectId,
        lotId: row.lotId,
        amountMicro: row.creditsMicro,
        idempotencyKey: `reorg-reverse:${row.chainTx}:${row.logIndex}:${
          row.blockHash ?? row.blockNumber ?? "unknown"
        }:${row.lotId ?? "no-lot"}`,
      });
    }

    await db.update(deposits).set({ status: "reorged" }).where(eq(deposits.id, row.id));
    await recordDeadLetter({
      chainTx: row.chainTx,
      logIndex: row.logIndex,
      error: reason,
      attempts: count,
    });
    flagged += 1;
    deps.onFlag?.({
      depositId: row.id,
      chainTx: row.chainTx,
      logIndex: row.logIndex,
      reason,
    });
  }

  return { checked: rows.length, repaired, restored, flagged };
}
