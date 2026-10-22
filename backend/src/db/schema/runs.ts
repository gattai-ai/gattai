import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { runStatusEnum, stepStatusEnum } from "./enums";
import { projects } from "./account";

/** Definisi recipe (dari recipes.yaml) beserta versinya. */
export const recipes = pgTable(
  "recipes",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    configJson: jsonb("config_json").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("recipes_id_version_idx").on(table.id, table.version)],
);

/** Satu eksekusi recipe. */
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    recipeId: text("recipe_id").notNull(),
    recipeVersion: integer("recipe_version").notNull().default(1),
    status: runStatusEnum("status").notNull().default("CREATED"),
    mode: text("mode").notNull().default("streaming"),
    conversationId: text("conversation_id"),
    input: text("input").notNull(),
    output: jsonb("output"),
    reservedMicro: bigint("reserved_micro", { mode: "number" }).notNull().default(0),
    chargedMicro: bigint("charged_micro", { mode: "number" }).notNull().default(0),
    /** Run ini dibiayai kuota trial gratis, bukan credit berbayar. */
    isTrial: boolean("is_trial").notNull().default(false),
    providerCostUsd: numeric("provider_cost_usd", { precision: 24, scale: 8 })
      .notNull()
      .default("0"),
    /**
     * Unik per project, bukan global. Dua project boleh memakai key yang sama
     * tanpa saling membocorkan run (lihat replay di create-run.ts).
     */
    idempotencyKey: text("idempotency_key").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Jantung run yang masih hidup. Runner memperbaruinya saat mulai dan di
     * setiap step; reaper memakai kolom ini, bukan `created_at`, agar run
     * panjang tidak dianggap yatim hanya karena sudah lama dibuat.
     */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("runs_project_idx").on(table.projectId, table.createdAt),
    // Idempotency-Key hanya bermakna di dalam satu project. Index global lama
    // membuat project B bisa memakai key project A dan menerima run A.
    uniqueIndex("runs_project_idempotency_idx").on(table.projectId, table.idempotencyKey),
    // Daftar riwayat percakapan join ke `runs.conversation_id`; tanpa index ini
    // query daftar jadi seq-scan begitu tabel run membesar.
    index("runs_conversation_idx").on(table.conversationId),
  ],
);

/** Satu baris per step dalam sebuah run. */
export const runSteps = pgTable(
  "run_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    role: text("role").notNull(),
    status: stepStatusEnum("status").notNull().default("PENDING"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    units: numeric("units", { precision: 18, scale: 6 }),
    providerCostUsd: numeric("provider_cost_usd", { precision: 24, scale: 8 })
      .notNull()
      .default("0"),
    latencyMs: integer("latency_ms"),
    output: jsonb("output"),
    error: text("error"),
    requestRef: text("request_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("run_steps_run_idx").on(table.runId)],
);
