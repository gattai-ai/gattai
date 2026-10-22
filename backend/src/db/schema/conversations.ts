import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { projects } from "./account";

/** Percakapan. `summary` menyimpan ringkasan rolling untuk menekan biaya konteks. */
export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("conversations_project_idx").on(table.projectId)],
);

/** Pesan dalam percakapan. `runId` menghubungkan pesan assistant dengan run-nya. */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("messages_conversation_idx").on(table.conversationId, table.createdAt)],
);
