import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Unit akun/ekonomi. Memiliki key, saldo, dan ledger.
 * Satu wallet bisa memiliki satu project (dibuat otomatis saat login SIWE pertama).
 */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerWallet: text("owner_wallet").notNull(),
    /**
     * ID project onchain: `keccak256(utf8(project.id))` sebagai hex 0x… (bytes32)
     * Dipakai `DepositManager.deposit(projectId, ...)` dan dipetakan balik oleh
     * deposit indexer. Diisi otomatis saat project dibuat.
     */
    onchainId: text("onchain_id"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("projects_owner_wallet_idx").on(table.ownerWallet),
    uniqueIndex("projects_onchain_id_idx").on(table.onchainId),
  ],
);

/**
 * API key project. Disimpan sebagai hash; key lengkap hanya ditampilkan sekali.
 * `prefix` disimpan demi tampilan di UI tanpa membuka key penuh.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [index("api_keys_prefix_idx").on(table.prefix)],
);

/**
 * Sesi web app (SIWE). Cookie hanya membawa `sid` bertanda tangan HMAC; otoritas
 * sesungguhnya ada di baris ini, sehingga sesi bisa **dicabut** (logout, ganti
 * owner wallet, logout-semua) — sesuatu yang mustahil pada token stateless murni.
 *
 * `expires_at` = batas absolut; `last_seen_at` = dasar idle timeout. Baris
 * kedaluwarsa dibersihkan berkala oleh reaper.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Alamat wallet penandatangan (lowercase), dibandingkan dengan owner project. */
    address: text("address").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("sessions_project_idx").on(table.projectId),
    index("sessions_expires_idx").on(table.expiresAt),
  ],
);
