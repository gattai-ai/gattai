import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Kursor rantai persisten per worker.
 *
 * Disimpan di DB (bukan memori) supaya restart proses (termasuk `bun --watch`)
 * tidak men-scan ulang dari `INDEXER_FROM_BLOCK` — yang bisa puluhan ribu blok
 * dan memicu rate-limit RPC.
 */
export const chainCursors = pgTable("chain_cursors", {
  name: text("name").primaryKey(),
  blockNumber: bigint("block_number", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Dead-letter deposit: log `Deposited` yang gagal diproses berulang (poison pill).
 * Dicatat agar tidak ada deposit yang "hilang diam-diam" dan bisa ditinjau manual.
 */
export const depositDeadLetters = pgTable(
  "deposit_dead_letters",
  {
    id: text("id").primaryKey(),
    chainTx: text("chain_tx").notNull(),
    logIndex: integer("log_index").notNull(),
    projectId: text("project_id"),
    payer: text("payer"),
    token: text("token"),
    amountRaw: text("amount_raw"),
    error: text("error").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("deposit_dead_letters_tx_log_idx").on(table.chainTx, table.logIndex),
    index("deposit_dead_letters_created_idx").on(table.createdAt),
  ],
);
