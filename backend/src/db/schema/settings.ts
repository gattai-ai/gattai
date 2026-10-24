import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { projects } from "./account";

/**
 * Preferensi publik per project.
 *
 * Saat ini hanya opt-out leaderboard. Baris ada = project tidak tampil di
 * peringkat publik; menghapus baris = ikut lagi. Dipisah dari `projects` supaya
 * data akun tidak tercampur dengan preferensi yang bisa diubah user.
 */
export const leaderboardOptOuts = pgTable("leaderboard_opt_outs", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
