import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projects } from "./account";
import { runs } from "./runs";

/**
 * Share publik satu run. Slug acak 128-bit adalah satu-satunya kunci yang
 * boleh dipakai di URL — jangan pernah memakai run/project id yang bisa
 * ditebak atau membocorkan identitas internal.
 *
 * `revoked_at` dipertahankan (bukan hard delete) supaya tautan lama tetap mati
 * dan audit "kapan dicabut" tidak hilang. Share ulang memakai slug baru.
 */
export const runShares = pgTable(
  "run_shares",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    showPrompt: boolean("show_prompt").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("run_shares_run_idx").on(table.runId),
    uniqueIndex("run_shares_slug_idx").on(table.slug),
    index("run_shares_project_idx").on(table.projectId, table.createdAt),
  ],
);
