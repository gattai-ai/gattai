import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { burnEpochs } from "../db/schema";
import { ApiError } from "../lib/http";
import { newId } from "../lib/id";
import { usd8ToDecimalString } from "../onchain/credits";
import { tokens18ToDecimalString } from "./money";
import type { BurnBreakdown, BurnWindow } from "./types";

/**
 * Pencatatan epoch buyback & burn.
 *
 * Idempotent per `period_start` (unique index): menjalankan worker berulang
 * untuk jendela yang sama tidak menggandakan baris. Epoch yang sudah
 * `executed` tidak pernah ditimpa.
 */

export type EpochStatus = "pending" | "executed" | "failed";

export interface RecordEpochInput {
  window: BurnWindow;
  breakdown: BurnBreakdown;
  status: EpochStatus;
  tokensBurned18: bigint;
  txHashes: string[];
  priceSource: string | null;
  priceError: string | null;
  /** Galat eksekusi onchain (bila ada), mis. buyback belum tersedia. */
  executionError?: string | null;
  /** `dry-run` (direncanakan) atau `onchain`/`multisig` (dieksekusi). */
  mode: string;
  runsCount: number;
}

export interface RecordEpochResult {
  id: string;
  created: boolean;
  status: EpochStatus;
}

function detailsFor(input: RecordEpochInput): Record<string, unknown> {
  return {
    mode: input.mode,
    runs_count: input.runsCount,
    stable_margin_usd: usd8ToDecimalString(input.breakdown.stableMarginUsd8),
    token_margin_usd: usd8ToDecimalString(input.breakdown.tokenMarginUsd8),
    stable_budget_usd: usd8ToDecimalString(input.breakdown.stableBudgetUsd8),
    token_budget_usd: usd8ToDecimalString(input.breakdown.tokenBudgetUsd8),
    gattai_price_usd:
      input.breakdown.gattaiPrice8 === null
        ? null
        : usd8ToDecimalString(input.breakdown.gattaiPrice8),
    price_source: input.priceSource,
    price_error: input.priceError,
    execution_error: input.executionError ?? null,
    planned_buyback_tokens: tokens18ToDecimalString(input.breakdown.buybackTokens18),
    planned_direct_burn_tokens: tokens18ToDecimalString(input.breakdown.directBurnTokens18),
  };
}

/** Catat/segarkan epoch. Epoch `executed` yang sudah ada tidak diubah. */
export async function recordEpoch(input: RecordEpochInput): Promise<RecordEpochResult> {
  const existing = await findEpochRow(input.window.start);
  if (!existing) {
    try {
      const id = newId("epoch");
      await db.insert(burnEpochs).values({
        id,
        periodStart: input.window.start,
        periodEnd: input.window.end,
        budgetUsd: usd8ToDecimalString(input.breakdown.totalBudgetUsd8),
        tokensBurned: tokens18ToDecimalString(input.tokensBurned18),
        txHashes: input.txHashes,
        status: input.status,
        details: detailsFor(input),
      });
      return { id, created: true, status: input.status };
    } catch {
      // Balapan dengan worker lain di window baru yang sama (unique index
      // `period_start`): baca ulang pemenang, bukan crash.
      const raced = await findEpochRow(input.window.start);
      if (!raced) throw new ApiError(500, "EPOCH_RECORD_FAILED", "Failed to record the epoch. Try again.");
      return refreshEpoch(raced.id, raced.status, input);
    }
  }
  return refreshEpoch(existing.id, existing.status, input);
}

async function findEpochRow(periodStart: Date): Promise<{ id: string; status: string } | null> {
  const rows = await db
    .select({ id: burnEpochs.id, status: burnEpochs.status })
    .from(burnEpochs)
    .where(eq(burnEpochs.periodStart, periodStart))
    .limit(1);
  return rows[0] ?? null;
}

/** Segarkan epoch non-executed; epoch `executed` tidak pernah diubah. */
async function refreshEpoch(
  id: string,
  status: string,
  input: RecordEpochInput,
): Promise<RecordEpochResult> {
  if (status === "executed") {
    return { id, created: false, status: "executed" };
  }
  await db
    .update(burnEpochs)
    .set({
      periodEnd: input.window.end,
      budgetUsd: usd8ToDecimalString(input.breakdown.totalBudgetUsd8),
      tokensBurned: tokens18ToDecimalString(input.tokensBurned18),
      txHashes: input.txHashes,
      status: input.status,
      details: detailsFor(input),
    })
    .where(eq(burnEpochs.id, id));
  return { id, created: false, status: input.status };
}

/** Tandai epoch (berdasarkan `period_start`) selesai dieksekusi treasury. */
export async function markEpochExecuted(input: {
  periodStart: Date;
  txHashes: string[];
  tokensBurned18: bigint;
}): Promise<boolean> {
  const updated = await db
    .update(burnEpochs)
    .set({
      status: "executed",
      txHashes: input.txHashes,
      tokensBurned: tokens18ToDecimalString(input.tokensBurned18),
    })
    .where(eq(burnEpochs.periodStart, input.periodStart))
    .returning({ id: burnEpochs.id });
  return updated.length > 0;
}

export function listEpochs(limit = 50, offset = 0) {
  return db
    .select()
    .from(burnEpochs)
    .orderBy(desc(burnEpochs.periodEnd), desc(burnEpochs.id))
    .limit(limit)
    .offset(offset);
}

export function findEpochByPeriodStart(periodStart: Date) {
  return db
    .select()
    .from(burnEpochs)
    .where(eq(burnEpochs.periodStart, periodStart))
    .limit(1);
}

/** Total GATTAI terbakar (hanya epoch `executed`), sebagai string desimal 18. */
export async function burnedTotalTokens(): Promise<string> {
  const rows = await db
    .select({
      total: sql<string>`coalesce(sum(${burnEpochs.tokensBurned}) filter (where ${burnEpochs.status} = 'executed'), 0)`,
    })
    .from(burnEpochs);
  return rows[0]?.total ?? "0";
}

// ── Jendela epoch ────────────────────────────────────────────────────────────

/** Bulatkan waktu ke bawah pada kelipatan `durationMs` (UTC). */
export function alignDown(date: Date, durationMs: number): Date {
  const ms = date.getTime();
  return new Date(Math.floor(ms / durationMs) * durationMs);
}

/**
 * Daftar jendela penuh `[start, end)` dari `genesis` hingga `now`.
 * Jendela yang belum tertutup (end > now) tidak disertakan.
 */
export function enumerateWindows(genesis: Date, now: Date, durationMs: number): BurnWindow[] {
  const windows: BurnWindow[] = [];
  const nowMs = now.getTime();
  let start = genesis.getTime();
  while (start + durationMs <= nowMs) {
    windows.push({ start: new Date(start), end: new Date(start + durationMs) });
    start += durationMs;
  }
  return windows;
}
