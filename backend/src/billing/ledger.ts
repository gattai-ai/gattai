import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { creditLots, ledgerEntries, runs } from "../db/schema";
import { newId } from "../lib/id";

/**
 * Ledger append-only + konsumsi lot FIFO.
 *
 * Konvensi tanda `amount_micro`:
 *   positif → menambah saldo (DEPOSIT, PROMO, RELEASE, ADJUST+)
 *   negatif → mengurangi saldo (RESERVE, SETTLE, ADJUST-)
 *
 * Saldo selalu = Σ amount_micro seluruh ledger project.
 * Setiap penulisan dibungkus transaksi yang mengunci baris project agar
 * perhitungan `balance_after_micro` konsisten.
 */

const MICRO_TOTAL = sql<string>`coalesce(sum(${ledgerEntries.amountMicro}), 0)`;

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.execute(sql`select id from projects where id = ${projectId} for update`);
}

export async function currentBalance(tx: Tx, projectId: string): Promise<number> {
  const rows = await tx
    .select({ total: MICRO_TOTAL })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.projectId, projectId));
  return Number(rows[0]?.total ?? 0);
}

interface AppendInput {
  projectId: string;
  type: "DEPOSIT" | "RESERVE" | "SETTLE" | "RELEASE" | "ADJUST" | "PROMO";
  amountMicro: number;
  idempotencyKey: string;
  runId?: string | null;
  lotId?: string | null;
}

/**
 * Menambahkan entri ledger. Jika `idempotencyKey` sudah ada, entri dilewati
 * (retry aman, tidak pernah menagih dua kali). Mengembalikan saldo setelah entri.
 */
async function appendLedger(
  tx: Tx,
  input: AppendInput,
): Promise<{ applied: boolean; balanceAfterMicro: number }> {
  const balanceAfterMicro = (await currentBalance(tx, input.projectId)) + input.amountMicro;
  const inserted = await tx
    .insert(ledgerEntries)
    .values({
      id: newId("led"),
      projectId: input.projectId,
      runId: input.runId ?? null,
      lotId: input.lotId ?? null,
      type: input.type,
      amountMicro: input.amountMicro,
      balanceAfterMicro,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: ledgerEntries.idempotencyKey })
    .returning({ id: ledgerEntries.id });

  return { applied: inserted.length > 0, balanceAfterMicro };
}

// ── Saldo & baca ─────────────────────────────────────────────────────────────

export async function getBalanceMicro(projectId: string): Promise<number> {
  const rows = await db
    .select({ total: MICRO_TOTAL })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.projectId, projectId));
  return Number(rows[0]?.total ?? 0);
}

export function listLots(projectId: string) {
  return db
    .select()
    .from(creditLots)
    .where(eq(creditLots.projectId, projectId))
    .orderBy(asc(creditLots.createdAt), asc(creditLots.id));
}

export function listLedger(projectId: string, limit = 50, offset = 0) {
  return db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.projectId, projectId))
    .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
    .limit(limit)
    .offset(offset);
}

// ── Mutasi ───────────────────────────────────────────────────────────────────

export interface ReserveResult {
  ok: boolean;
  /**
   * `false` bila reservasi untuk run ini sudah ada (retry / executor kedua).
   * Pemanggil TIDAK boleh menganggap dirinya pemilik run dalam kasus itu.
   */
  applied: boolean;
  balanceMicro: number;
}

/** Menahan credits sebesar estimasi + buffer. */
export async function reserve(input: {
  projectId: string;
  runId: string;
  amountMicro: number;
}): Promise<ReserveResult> {
  if (input.amountMicro <= 0) {
    const balance = await getBalanceMicro(input.projectId);
    return { ok: true, applied: false, balanceMicro: balance };
  }

  return db.transaction(async (tx) => {
    await lockProject(tx, input.projectId);
    const balance = await currentBalance(tx, input.projectId);

    // Sudah pernah direservasi (mis. dua request mengeksekusi run yang sama
    // atau retry setelah timeout). Jangan menahan dua kali, dan jangan mengaku
    // sebagai pemilik reservasi.
    const existing = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.idempotencyKey, `${input.runId}:reserve`))
      .limit(1);
    if (existing[0]) {
      return { ok: true, applied: false, balanceMicro: balance };
    }

    if (balance < input.amountMicro) {
      return { ok: false, applied: false, balanceMicro: balance };
    }
    await appendLedger(tx, {
      projectId: input.projectId,
      runId: input.runId,
      type: "RESERVE",
      amountMicro: -input.amountMicro,
      idempotencyKey: `${input.runId}:reserve`,
    });
    return { ok: true, applied: true, balanceMicro: balance - input.amountMicro };
  });
}

/**
 * Sisa reservasi yang masih tertahan untuk sebuah run, dihitung dari ledger.
 *
 * Dipakai reaper untuk crash yang terjadi setelah `reserve` menulis ledger
 * tetapi sebelum kolom `runs.reserved_micro` sempat diperbarui.
 */
export async function outstandingReserveMicroTx(tx: Tx, runId: string): Promise<number> {
  const rows = await tx
    .select({
      total: sql<string>`coalesce(sum(${ledgerEntries.amountMicro}), 0)`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.runId, runId),
        sql`${ledgerEntries.type} in ('RESERVE', 'RELEASE')`,
      ),
    );
  const net = Number(rows[0]?.total ?? 0);
  return net < 0 ? -net : 0;
}

export async function outstandingReserveMicro(runId: string): Promise<number> {
  return db.transaction((tx) => outstandingReserveMicroTx(tx, runId));
}

/**
 * Inti pelepasan reservasi, dijalankan di dalam transaksi pemanggil. Dipakai
 * reaper agar klaim status run dan pelepasan hold terjadi atomik: tidak ada
 * jendela crash di mana run sudah RELEASED tetapi reservasi masih tertahan.
 */
export async function releaseTx(
  tx: Tx,
  input: { projectId: string; runId: string; amountMicro: number },
): Promise<void> {
  if (input.amountMicro <= 0) return;
  await lockProject(tx, input.projectId);
  await appendLedger(tx, {
    projectId: input.projectId,
    runId: input.runId,
    type: "RELEASE",
    amountMicro: input.amountMicro,
    idempotencyKey: `${input.runId}:release`,
  });
}

/** Melepas reservasi yang tidak terpakai. */
export async function release(input: {
  projectId: string;
  runId: string;
  amountMicro: number;
}): Promise<void> {
  if (input.amountMicro <= 0) return;
  await db.transaction((tx) => releaseTx(tx, input));
}

/**
 * Menyelesaikan run: lepas seluruh reservasi, konsumsi `chargedMicro` secara
 * FIFO dari lot, catat lot yang dikonsumsi (dasar perhitungan burn), dan
 * (bila diminta) perbarui status run **dalam transaksi yang sama**.
 *
 * Status run sengaja diperbarui di sini, bukan oleh pemanggil: kalau ledger
 * sudah settle tetapi update status gagal, reaper/retry bisa melihat run
 * seolah masih berjalan. Satu transaksi menutup celah itu.
 */
export async function settleRun(input: {
  projectId: string;
  runId: string;
  reservedMicro: number;
  chargedMicro: number;
  /** Bila diisi, baris `runs` ikut di-update atomik dengan settlement. */
  finalStatus?: "SETTLED" | "RELEASED";
  output?: unknown;
  error?: string | null;
  providerCostUsd?: number;
}): Promise<void> {
  const reservedMicro = Math.max(0, input.reservedMicro);
  const chargedMicro = Math.max(0, input.chargedMicro);

  await db.transaction(async (tx) => {
    await lockProject(tx, input.projectId);

    // Penanda settlement: membuat seluruh fungsi idempoten. Sebelum penanda
    // ini ada, retry `settleRun` mengurangi `credit_lots.remaining_micro`
    // lagi walau entri ledger-nya di-skip oleh idempotency key.
    const settled = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.idempotencyKey, `${input.runId}:settled`))
      .limit(1);

    if (!settled[0]) {
      // Lepas seluruh hold terlebih dahulu.
      if (reservedMicro > 0) {
        await appendLedger(tx, {
          projectId: input.projectId,
          runId: input.runId,
          type: "RELEASE",
          amountMicro: reservedMicro,
          idempotencyKey: `${input.runId}:release`,
        });
      }

      // Konsumsi lot FIFO. Update lot hanya dilakukan bila entri ledger benar-
      // benar masuk; kalau key sudah ada (mis. sisa percobaan lama), lot tidak
      // boleh ikut berkurang.
      let remaining = chargedMicro;
      const lots = await tx
        .select()
        .from(creditLots)
        .where(and(eq(creditLots.projectId, input.projectId), gt(creditLots.remainingMicro, 0)))
        .orderBy(asc(creditLots.createdAt), asc(creditLots.id));

      for (const lot of lots) {
        if (remaining <= 0) break;
        const take = Math.min(lot.remainingMicro, remaining);
        const entry = await appendLedger(tx, {
          projectId: input.projectId,
          runId: input.runId,
          lotId: lot.id,
          type: "SETTLE",
          amountMicro: -take,
          idempotencyKey: `${input.runId}:settle:${lot.id}`,
        });
        if (!entry.applied) continue;

        await tx
          .update(creditLots)
          .set({
            remainingMicro: sql`greatest(${creditLots.remainingMicro} - ${take}, 0)`,
          })
          .where(eq(creditLots.id, lot.id));
        remaining -= take;
      }

      // Jika charged melebihi lot tersedia, catat sisa tanpa lot (saldo bisa negatif).
      if (remaining > 0) {
        await appendLedger(tx, {
          projectId: input.projectId,
          runId: input.runId,
          type: "SETTLE",
          amountMicro: -remaining,
          idempotencyKey: `${input.runId}:settle:overflow`,
        });
      }

      await appendLedger(tx, {
        projectId: input.projectId,
        runId: input.runId,
        type: "ADJUST",
        amountMicro: 0,
        idempotencyKey: `${input.runId}:settled`,
      });
    }

    if (input.finalStatus) {
      await tx
        .update(runs)
        .set({
          status: input.finalStatus,
          chargedMicro,
          providerCostUsd:
            input.providerCostUsd !== undefined ? String(input.providerCostUsd) : undefined,
          output: input.output,
          error: input.error,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(runs.id, input.runId),
            inArray(runs.status, ["CREATED", "RESERVED", "RUNNING", "RELEASED"]),
          ),
        );
    }
  });
}

/**
 * Mencatat deposit/promo: membuat lot baru + entri ledger DEPOSIT/PROMO.
 * Idempotent per `idempotencyKey` (untuk deposit: tx:logIndex).
 */
/**
 * Input pembuatan lot. Idempotent per `idempotencyKey`
 * (untuk deposit: `deposit:{tx}:{logIndex}`).
 */
export interface CreditLotInput {
  projectId: string;
  source: "ETH" | "USDG" | "GATTAI" | "PROMO";
  amountMicro: number;
  idempotencyKey: string;
  depositTx?: string | null;
}

/**
 * Inti pembuatan lot + entri ledger, dijalankan **di dalam transaksi pemanggil**
 * agar lot + ledger + update baris deposit bisa atomik (satu transaksi).
 *
 * Idempotent per `idempotencyKey`; bila kunci sudah ada, mengembalikan `lotId`
 * yang sudah ada supaya tautan deposit→lot tidak pernah hilang saat retry.
 */
export async function recordCreditLotTx(
  tx: Tx,
  input: CreditLotInput,
): Promise<{ applied: boolean; lotId: string | null }> {
  if (input.amountMicro <= 0) return { applied: false, lotId: null };

  // Kunci project DULU, baru cek idempotensi. Urutan sebaliknya membuka
  // balapan: dua transaksi sama-sama melihat "belum ada", lalu sama-sama
  // membuat lot; ledger hanya menolak salah satunya, tetapi lot yatim sudah
  // terlanjur tersimpan.
  await lockProject(tx, input.projectId);

  const existing = await tx
    .select({ lotId: ledgerEntries.lotId })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing[0]) return { applied: false, lotId: existing[0].lotId };

  const lotId = newId("lot");
  await tx.insert(creditLots).values({
    id: lotId,
    projectId: input.projectId,
    source: input.source,
    depositTx: input.depositTx ?? null,
    amountMicro: input.amountMicro,
    remainingMicro: input.amountMicro,
  });

  const entry = await appendLedger(tx, {
    projectId: input.projectId,
    lotId,
    type: input.source === "PROMO" ? "PROMO" : "DEPOSIT",
    amountMicro: input.amountMicro,
    idempotencyKey: input.idempotencyKey,
  });

  // Kunci idempotensi global; bila pemenangnya transaksi lain, lot yang baru
  // kita buat tidak boleh tertinggal tanpa ledger.
  if (!entry.applied) {
    await tx.delete(creditLots).where(eq(creditLots.id, lotId));
    const winner = await tx
      .select({ lotId: ledgerEntries.lotId })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.idempotencyKey, input.idempotencyKey))
      .limit(1);
    return { applied: false, lotId: winner[0]?.lotId ?? null };
  }

  return { applied: true, lotId };
}

/**
 * Mencatat deposit/promo: membuat lot baru + entri ledger DEPOSIT/PROMO
 * dalam satu transaksi sendiri. Idempotent per `idempotencyKey`.
 */
export function recordCreditLot(input: CreditLotInput) {
  return db.transaction((tx) => recordCreditLotTx(tx, input));
}

/**
 * Membatalkan kredit (mis. tx keluar dari rantai kanonik saat reorg):
 * kurangi `remainingMicro` lot (bila ada) + entri ledger ADJUST negatif.
 * Idempotent per `idempotencyKey` (mis. `reorg:{tx}:{logIndex}`).
 * Saldo boleh menjadi negatif bila credits sudah terpakai — utang tercatat.
 */
export async function reverseCredit(input: {
  projectId: string;
  lotId: string | null;
  amountMicro: number;
  idempotencyKey: string;
}): Promise<{ applied: boolean }> {
  if (input.amountMicro <= 0) return { applied: false };
  return db.transaction(async (tx) => {
    await lockProject(tx, input.projectId);

    // Tulis ledger lebih dulu. Bila key sudah ada (retry), jangan sentuh lot:
    // versi lama mengurangi `remaining_micro` sebelum tahu entri di-skip,
    // sehingga saldo lot bisa terkikis dua kali.
    const { applied } = await appendLedger(tx, {
      projectId: input.projectId,
      lotId: input.lotId,
      type: "ADJUST",
      amountMicro: -input.amountMicro,
      idempotencyKey: input.idempotencyKey,
    });
    if (!applied) return { applied: false };

    if (input.lotId) {
      await tx
        .update(creditLots)
        .set({
          remainingMicro: sql`greatest(${creditLots.remainingMicro} - ${input.amountMicro}, 0)`,
        })
        .where(eq(creditLots.id, input.lotId));
    }

    return { applied: true };
  });
}

/** Penyesuaian manual (koreksi), append-only. */
export async function adjust(input: {
  projectId: string;
  amountMicro: number;
  idempotencyKey: string;
  runId?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await lockProject(tx, input.projectId);
    await appendLedger(tx, {
      projectId: input.projectId,
      runId: input.runId ?? null,
      type: "ADJUST",
      amountMicro: input.amountMicro,
      idempotencyKey: input.idempotencyKey,
    });
  });
}
