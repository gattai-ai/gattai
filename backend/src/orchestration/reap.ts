import { and, eq, inArray, lt } from "drizzle-orm";
import { SESSION_RETENTION_MS, purgeStaleSessions } from "../auth/session";
import { db } from "../db";
import { runs } from "../db/schema";
import { lockProject, outstandingReserveMicroTx, releaseTx } from "../billing/ledger";
import { dropConversationIfEmpty } from "../services/conversations";
import { runEvents } from "./events";

/**
 * Reaper run yatim: run yang macet di status non-terminal (mis. server
 * restart di tengah eksekusi) tidak akan pernah selesai sendiri — worker
 * fire-and-forget sudah hilang dan SSE akan menggantung selamanya.
 * Reaper menandai run kedaluwarsa sebagai RELEASED tanpa tagihan dan
 * memastikan reservasinya dilepas via `settleRun` yang sudah ada.
 *
 * AWAITING_CONFIRMATION tidak menahan reservasi apa pun (reserve baru terjadi saat
 * eksekusi). Karena run itu belum pernah memanggil provider dan tidak punya
 * entri ledger, barisnya **dihapus** setelah `confirmExpiryMs` — persis seperti
 * `POST /v1/runs/:id/cancel`. Menandainya `RELEASED` akan membakar jatah media
 * untuk run yang biayanya nol (lihat catatan di cabang kedaluwarsa).
 */

const STUCK_STATUSES = ["CREATED", "RESERVED", "RUNNING"] as const;

export interface ReapResult {
  reaped: number;
  runIds: string[];
}

export interface ReapInput {
  /** Umur run non-terminal sebelum dianggap yatim (ms). */
  staleAfterMs: number;
  /** Umur estimasi AWAITING_CONFIRMATION sebelum kedaluwarsa (ms). */
  confirmExpiryMs: number;
}

/** Tandai run macet/kedaluwarsa sebagai RELEASED tanpa tagihan. */
export async function reapStaleRuns(input: ReapInput): Promise<ReapResult> {
  const now = Date.now();
  const runIds: string[] = [];

  // Housekeeping: sesi yang sudah mati (dicabut/kedaluwarsa) hanya menumpuk.
  // Dibersihkan setelah masa retensi singkat; tidak memengaruhi hasil reap run.
  await purgeStaleSessions(SESSION_RETENTION_MS);

  const staleBefore = new Date(now - input.staleAfterMs);
  const stale = await db
    .select({
      id: runs.id,
      projectId: runs.projectId,
      reservedMicro: runs.reservedMicro,
    })
    .from(runs)
    .where(
      and(
        inArray(runs.status, [...STUCK_STATUSES]),
        lt(runs.heartbeatAt, staleBefore),
      ),
    );

  for (const row of stale) {
    // Klaim status + pelepasan reservasi dalam SATU transaksi. Sebelumnya
    // klaim dan release terpisah: crash di antaranya meninggalkan run
    // RELEASED dengan hold yang masih tertahan selamanya.
    //
    // Kunci project lebih dulu agar urutan lock sama dengan runner
    // (project → run), menghindari deadlock.
    const claimedId = await db.transaction(async (tx) => {
      await lockProject(tx, row.projectId);

      const claimed = await tx
        .update(runs)
        .set({
          status: "RELEASED",
          error: "Run expired before completion (reaper).",
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(runs.id, row.id),
            inArray(runs.status, [...STUCK_STATUSES]),
            lt(runs.heartbeatAt, staleBefore),
          ),
        )
        .returning({ id: runs.id, reservedMicro: runs.reservedMicro });
      if (claimed.length === 0) return null;

      // Ledger adalah sumber kebenaran: crash bisa terjadi setelah RESERVE
      // ditulis tetapi sebelum `runs.reserved_micro` diperbarui.
      const outstanding = await outstandingReserveMicroTx(tx, row.id);
      const amountMicro =
        outstanding > 0 ? outstanding : (claimed[0]!.reservedMicro ?? 0);
      await releaseTx(tx, {
        projectId: row.projectId,
        runId: row.id,
        amountMicro,
      });
      return row.id;
    });

    if (claimedId) runIds.push(claimedId);
  }

  // Estimasi formasi media yang tak kunjung dikonfirmasi: run ini belum pernah
  // memanggil provider, tidak menahan reservasi, dan tidak punya entri ledger —
  // jadi barisnya DIHAPUS, persis seperti `POST /v1/runs/:id/cancel`.
  //
  // Perilaku lama (menandai `RELEASED`) membakar jatah media secara percuma:
  // `mediaAttempts` dihitung tanpa filter refund, sehingga run yang biaya
  // providernya NOL tetap memotong jatah. Akibatnya klien yang kehilangan
  // respons POST (timeout jaringan) kehilangan satu dari dua jatah medianya
  // secara permanen — padahal tidak ada biaya yang keluar sama sekali.
  //
  // Penghapusan bersyarat menjaga balapan dengan `POST /:id/confirm`: run yang
  // keburu dikonfirmasi (status berpindah) tidak akan terhapus.
  const expired = await db
    .select({ id: runs.id, conversationId: runs.conversationId })
    .from(runs)
    .where(
      and(
        eq(runs.status, "AWAITING_CONFIRMATION"),
        lt(runs.createdAt, new Date(now - input.confirmExpiryMs)),
      ),
    );

  for (const row of expired) {
    const deleted = await db
      .delete(runs)
      .where(
        and(
          eq(runs.id, row.id),
          eq(runs.status, "AWAITING_CONFIRMATION"),
          eq(runs.reservedMicro, 0),
        ),
      )
      .returning({ id: runs.id });
    if (deleted.length === 0) continue;
    // Percakapan yang kehilangan run terakhirnya tidak muncul di riwayat; hapus
    // supaya barisnya tidak menggantung (pesan ikut lewat cascade).
    await dropConversationIfEmpty(row.conversationId);
    // Lepaskan klien SSE (bila ada) agar tidak menggantung menunggu run yang hilang.
    runEvents.emit(row.id, { type: "done", status: "CANCELLED" });
    runIds.push(row.id);
  }

  return { reaped: runIds.length, runIds };
}

export interface ReaperHandle {
  /** Hentikan timer berkala. */
  stop: () => void;
  /** Jalankan satu siklus sekarang (dipakai test dan startup). */
  runOnce: () => Promise<ReapResult>;
}

export interface ReaperScheduleInput extends ReapInput {
  /** Selang antar siklus (ms). */
  intervalMs: number;
  /** Jalankan satu siklus segera saat di-start. Default `true`. */
  immediate?: boolean;
  /** Pencatat pesan; default `console.log`. */
  log?: (message: string) => void;
}

/**
 * Jalankan reaper secara berkala.
 *
 * Reaper sekali-jalan saat startup tidak cukup: server yang hidup lama menahan
 * reservasi run macet dan estimasi media kedaluwarsa sampai ada restart. Timer
 * ini menutup celah itu. Siklus yang belum selesai tidak ditumpuk (`busy`) dan
 * error ditelan agar reaper tidak pernah menjatuhkan proses.
 */
export function startReaper(input: ReaperScheduleInput): ReaperHandle {
  const log = input.log ?? ((message: string) => console.log(message));
  let busy = false;

  async function runOnce(): Promise<ReapResult> {
    if (busy) return { reaped: 0, runIds: [] };
    busy = true;
    try {
      const result = await reapStaleRuns(input);
      if (result.reaped > 0) log(`[reaper] ${result.reaped} run yatim di-reap`);
      return result;
    } catch (error) {
      log(`[reaper] gagal me-reap run yatim: ${error instanceof Error ? error.message : error}`);
      return { reaped: 0, runIds: [] };
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void runOnce(), input.intervalMs);
  // Tidak menahan proses saat shutdown/test (Node/Bun sama-sama punya `unref`).
  (timer as { unref?: () => void }).unref?.();

  // Siklus pertama segera, menggantikan pemanggilan sekali-jalan saat startup.
  if (input.immediate !== false) void runOnce();

  return { stop: () => clearInterval(timer), runOnce };
}
