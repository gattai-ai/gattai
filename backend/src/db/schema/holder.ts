import { bigint, index, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { projects } from "./account";
import { runs } from "./runs";

/**
 * Snapshot saldo token $GATTAI onchain per wallet.
 *
 * Tier dihitung dari saldo minimum pada dua snapshot berturut-turut untuk
 * mencegah eksploitasi flash-loan dan buy-and-dump instan.
 */
export const holderSnapshots = pgTable(
  "holder_snapshots",
  {
    id: text("id").primaryKey(),
    wallet: text("wallet").notNull(),
    balanceRaw: text("balance_raw").notNull(),
    balanceTokens: numeric("balance_tokens", { precision: 28, scale: 4 }).notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockHash: text("block_hash"),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("holder_snapshots_wallet_taken_idx").on(table.wallet, table.takenAt),
    index("holder_snapshots_taken_idx").on(table.takenAt),
  ],
);

/**
 * Audit biaya provider yang disubsidi untuk setiap run holder gratis.
 */
export const holderCostLedger = pgTable(
  "holder_cost_ledger",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    wallet: text("wallet").notNull(),
    tier: text("tier").notNull(),
    costUsd: numeric("cost_usd", { precision: 24, scale: 8 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("holder_cost_ledger_wallet_idx").on(table.wallet),
    index("holder_cost_ledger_created_idx").on(table.createdAt),
    index("holder_cost_ledger_run_idx").on(table.runId),
  ],
);

/**
 * Catatan fee Pons yang dialokasikan untuk mendanai pool run holder gratis.
 * Dipakai pada section "Holder runs" di /stats (Fase 6).
 */
export const holderFeeAllocations = pgTable(
  "holder_fee_allocations",
  {
    id: text("id").primaryKey(),
    txHash: text("tx_hash"),
    amountUsd: numeric("amount_usd", { precision: 24, scale: 6 }).notNull(),
    source: text("source").notNull().default("pons_fee_split"),
    notes: text("notes"),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("holder_fee_allocations_allocated_idx").on(table.allocatedAt),
  ],
);
