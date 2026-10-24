import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  burnEpochStatusEnum,
  burnKindEnum,
  depositStatusEnum,
  ledgerTypeEnum,
  lotSourceEnum,
} from "./enums";
import { projects } from "./account";

/**
 * Satu batch credits dari satu deposit, diberi tag sumber dana.
 * Tag `source` menentukan perhitungan burn (ETH/USDG → buyback, GATTAI → burn langsung).
 * Semua jumlah adalah micro-credits (integer).
 */
export const creditLots = pgTable(
  "credit_lots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    source: lotSourceEnum("source").notNull(),
    depositTx: text("deposit_tx"),
    amountMicro: bigint("amount_micro", { mode: "number" }).notNull(),
    remainingMicro: bigint("remaining_micro", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("credit_lots_project_idx").on(table.projectId, table.createdAt)],
);

/**
 * Ledger append-only. Tidak pernah di-update/di-delete.
 * `amount_micro` bertanda: positif menambah saldo, negatif mengurangi.
 * `balance_after_micro` menyimpan saldo berjalan untuk audit.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    lotId: text("lot_id").references(() => creditLots.id, { onDelete: "set null" }),
    type: ledgerTypeEnum("type").notNull(),
    amountMicro: bigint("amount_micro", { mode: "number" }).notNull(),
    balanceAfterMicro: bigint("balance_after_micro", { mode: "number" }).notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ledger_entries_project_idx").on(table.projectId, table.createdAt)],
);

/** Deposit onchain (Fase 2). Idempotent per (chain_tx, log_index). */
export const deposits = pgTable(
  "deposits",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chainTx: text("chain_tx").notNull(),
    logIndex: integer("log_index").notNull(),
    /** Alamat token yang di-deposit; `0x0000…0000` untuk ETH native. */
    token: text("token").notNull(),
    /** Alamat wallet pembayar onchain (lowercase), untuk audit. */
    payer: text("payer"),
    /** Sumber lot yang dibentuk dari deposit ini (menentukan jalur burn). */
    source: lotSourceEnum("source"),
    /** Jumlah mentah dalam satuan terkecil token (wei untuk ETH). */
    amountRaw: text("amount_raw").notNull(),
    /** Nilai USD (8 desimal) hasil valuasi. */
    usdValue: numeric("usd_value", { precision: 24, scale: 8 }).notNull().default("0"),
    /** Credits yang dikreditkan (micro-credits, sudah termasuk diskon GATTAI). */
    creditsMicro: bigint("credits_micro", { mode: "number" }).notNull().default(0),
    /** Lot credits yang dibuat dari deposit ini (bila sudah dikreditkan). */
    lotId: text("lot_id").references(() => creditLots.id, { onDelete: "set null" }),
    priceSource: text("price_source"),
    /** Nomor blok tx deposit (untuk deteksi reorg). */
    blockNumber: bigint("block_number", { mode: "number" }),
    /** Hash blok saat dikreditkan (pembanding deteksi reorg). */
    blockHash: text("block_hash"),
    confirmations: integer("confirmations").notNull().default(0),
    status: depositStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("deposits_tx_log_idx").on(table.chainTx, table.logIndex),
    index("deposits_project_idx").on(table.projectId, table.createdAt),
    index("deposits_status_created_idx").on(table.status, table.createdAt),
  ],
);

/** Rekap epoch buyback & burn. Dipublikasikan via /v1/public/burns. */
export const burnEpochs = pgTable(
  "burn_epochs",
  {
    id: text("id").primaryKey(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    budgetUsd: numeric("budget_usd", { precision: 24, scale: 8 }).notNull().default("0"),
    tokensBurned: numeric("tokens_burned", { precision: 38, scale: 18 }).notNull().default("0"),
    txHashes: text("tx_hashes").array().notNull().default([]),
    status: burnEpochStatusEnum("status").notNull().default("pending"),
    /**
     * Rincian audit: pemisahan budget stable/token, sumber harga GATTAI,
     * jumlah token terencana, dan mode eksekusi (dry-run/onchain/multisig).
     */
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Satu epoch per periode → pencatatan idempotent (worker aman diulang).
  (table) => [uniqueIndex("burn_epochs_period_idx").on(table.periodStart)],
);

/**
 * Burn token GATTAI yang diindeks langsung dari rantai.
 *
 * Sumber kebenaran untuk `/v1/public/burns`: setiap transfer token ke dead
 * address dicatat sekali per `(chain_tx, log_index)`. Jumlah disimpan sebagai
 * integer base-unit (numeric 78,0) — bukan float — agar audit tetap exact.
 *
 * `kind` diklasifikasikan saat ingest:
 *  - `epoch` bila tx ada di `burn_epochs.tx_hashes` (menang atas klasifikasi lain),
 *  - `team` bila pengirim ada di `TEAM_BURN_WALLETS`,
 *  - `community` untuk transfer sukarela lainnya.
 */
export const tokenBurns = pgTable(
  "token_burns",
  {
    id: text("id").primaryKey(),
    chainTx: text("chain_tx").notNull(),
    logIndex: integer("log_index").notNull(),
    tokenAddress: text("token_address").notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    /** Jumlah base-unit token (uint256), disimpan exact sebagai numeric(78,0). */
    amountRaw: numeric("amount_raw", { precision: 78, scale: 0 }).notNull(),
    decimals: integer("decimals").notNull().default(18),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockHash: text("block_hash"),
    /** Waktu blok; null bila RPC gagal saat backfill (bukan alasan menolak burn). */
    blockTimestamp: timestamp("block_timestamp", { withTimezone: true }),
    kind: burnKindEnum("kind").notNull(),
    /** Diisi bila `kind = epoch`; null untuk team/community. */
    epochId: text("epoch_id").references(() => burnEpochs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Idempotensi indexer: satu log hanya boleh tercatat sekali.
    uniqueIndex("token_burns_tx_log_idx").on(table.chainTx, table.logIndex),
    index("token_burns_block_idx").on(table.blockNumber),
    index("token_burns_kind_idx").on(table.kind, table.blockTimestamp),
  ],
);
