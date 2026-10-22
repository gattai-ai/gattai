import { and, eq, sql } from "drizzle-orm";
import { runs } from "../db/schema";
import type { Tx } from "./ledger";

/**
 * Kuota trial gratis per wallet.
 *
 * `attempts` menghitung **semua** run trial, termasuk yang gagal dan di-refund —
 * ini penjaga biaya platform, karena run yang gagal tetap menagih biaya provider.
 * `textUsed` menghitung kuota **teks** yang terpakai, yaitu run trial formasi teks
 * (`mode = 'streaming'`) kecuali yang berakhir tanpa output (gagal di tengah,
 * mangkrak, atau konfirmasi kedaluwarsa).
 * `mediaAttempts` menghitung percobaan formasi media dan **tidak** ikut dipulihkan
 * oleh refund: biaya provider media sudah keluar begitu percobaan dijalankan.
 *
 * Teks dan media adalah **dua anggaran mandiri**: run media tidak menambah
 * `textUsed`, sehingga 10 prompt teks tidak lagi membuat jatah media menjadi stok
 * mati (dulu media ikut memakan kuota yang sama, jadi `remaining = 0` menutup
 * jalur media).
 *
 * Karena semuanya **diturunkan** dari tabel `runs` (tidak ada counter tersimpan),
 * pengembalian kuota terjadi sendiri saat reaper mengubah status menjadi
 * `RELEASED` tanpa menulis `output`.
 */

/** Koneksi kueri: instance drizzle global atau transaksi yang sedang aktif. */
export type QueryExecutor = Pick<Tx, "select">;

export interface TrialState {
  /** Total percobaan trial, termasuk yang gagal. */
  attempts: number;
  /**
   * Kuota **teks** yang benar-benar terpakai (formasi `mode = 'streaming'`).
   * Run media punya anggaran sendiri di `mediaAttempts` dan tidak dihitung di
   * sini — kedua angka harus mandiri agar bisa ditampilkan berdampingan di UI.
   */
  textUsed: number;
  /**
   * Percobaan trial untuk formasi media (`mode <> 'streaming'`).
   * Sengaja dihitung **tanpa** filter refund: jatah media harus tetap terpakai
   * walau run-nya gagal, karena biaya provider media sudah keluar.
   */
  mediaAttempts: number;
  /** Batas kuota teks (params.trial.free_runs). */
  limit: number;
  /** Batas percobaan (params.trial.max_attempts). */
  maxAttempts: number;
  /** Sisa kuota teks; tidak pernah negatif. */
  remaining: number;
}

/** Hitung kuota trial dari tabel `runs`. Satu query, memakai `runs_project_idx`. */
export async function readTrialState(
  exec: QueryExecutor,
  projectId: string,
  limit: number,
  maxAttempts: number,
): Promise<TrialState> {
  const rows = await exec
    .select({
      attempts: sql<number>`count(*)::int`,
      textUsed: sql<number>`(count(*) filter (where ${runs.mode} = 'streaming' and not (${runs.status} = 'RELEASED' and ${runs.output} is null)))::int`,
      mediaAttempts: sql<number>`(count(*) filter (where ${runs.mode} <> 'streaming'))::int`,
    })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.isTrial, true)));

  const attempts = Number(rows[0]?.attempts ?? 0);
  const textUsed = Number(rows[0]?.textUsed ?? 0);
  const mediaAttempts = Number(rows[0]?.mediaAttempts ?? 0);
  return {
    attempts,
    textUsed,
    mediaAttempts,
    limit,
    maxAttempts,
    remaining: Math.max(0, limit - textUsed),
  };
}
