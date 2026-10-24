import { pgEnum } from "drizzle-orm/pg-core";

/** Sumber dana sebuah lot credits. Menentukan jalur burn. */
export const lotSourceEnum = pgEnum("lot_source", ["ETH", "USDG", "GATTAI", "PROMO"]);

/** Jenis entri ledger (append-only). */
export const ledgerTypeEnum = pgEnum("ledger_type", [
  "DEPOSIT",
  "RESERVE",
  "SETTLE",
  "RELEASE",
  "ADJUST",
  "PROMO",
]);

/** Status tinggi sebuah run (state machine). */
export const runStatusEnum = pgEnum("run_status", [
  "CREATED",
  "AWAITING_CONFIRMATION",
  "RESERVED",
  "RUNNING",
  "SETTLED",
  "RELEASED",
  "INSUFFICIENT_BALANCE",
]);

export const stepStatusEnum = pgEnum("step_status", ["PENDING", "RUNNING", "COMPLETE", "FAILED"]);

export const depositStatusEnum = pgEnum("deposit_status", [
  "pending",
  "confirmed",
  "over_cap",
  "failed",
  /** Nilai di bawah ambang minimum (anti-spam dust); tidak dikreditkan. */
  "dust",
  /** Gagal diproses berulang (poison pill) → perlu peninjauan manual. */
  "needs_review",
  /** Dibatalkan karena tx keluar dari rantai kanonik (reorg). */
  "reorged",
]);

export const burnEpochStatusEnum = pgEnum("burn_epoch_status", ["pending", "executed", "failed"]);

/**
 * Sumber sebuah burn token GATTAI.
 *
 * - `team`      : transfer dari wallet tim/treasury ke dead address.
 * - `epoch`     : tx yang tercatat pada epoch buyback & burn.
 * - `community` : transfer sukarela dari wallet lain ke dead address.
 */
export const burnKindEnum = pgEnum("burn_kind", ["team", "epoch", "community"]);
