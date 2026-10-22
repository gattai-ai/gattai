CREATE TYPE "public"."burn_epoch_status" AS ENUM('pending', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."deposit_status" AS ENUM('pending', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ledger_type" AS ENUM('DEPOSIT', 'RESERVE', 'SETTLE', 'RELEASE', 'ADJUST', 'PROMO');--> statement-breakpoint
CREATE TYPE "public"."lot_source" AS ENUM('ETH', 'USDG', 'GATTAI', 'PROMO');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('CREATED', 'AWAITING_CONFIRMATION', 'RESERVED', 'RUNNING', 'SETTLED', 'RELEASED', 'INSUFFICIENT_BALANCE');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('PENDING', 'RUNNING', 'COMPLETE', 'FAILED');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_wallet" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "burn_epochs" (
	"id" text PRIMARY KEY NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"budget_usd" numeric(24, 8) DEFAULT '0' NOT NULL,
	"tokens_burned" numeric(38, 18) DEFAULT '0' NOT NULL,
	"tx_hashes" text[] DEFAULT '{}' NOT NULL,
	"status" "burn_epoch_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"source" "lot_source" NOT NULL,
	"deposit_tx" text,
	"amount_micro" bigint NOT NULL,
	"remaining_micro" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"chain_tx" text NOT NULL,
	"log_index" integer NOT NULL,
	"token" text NOT NULL,
	"amount_raw" text NOT NULL,
	"usd_value" numeric(24, 8) DEFAULT '0' NOT NULL,
	"price_source" text,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"status" "deposit_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"lot_id" text,
	"type" "ledger_type" NOT NULL,
	"amount_micro" bigint NOT NULL,
	"balance_after_micro" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"config_json" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"role" text NOT NULL,
	"status" "step_status" DEFAULT 'PENDING' NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"units" numeric(18, 6),
	"provider_cost_usd" numeric(24, 8) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"output" jsonb,
	"error" text,
	"request_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"recipe_version" integer DEFAULT 1 NOT NULL,
	"status" "run_status" DEFAULT 'CREATED' NOT NULL,
	"mode" text DEFAULT 'streaming' NOT NULL,
	"conversation_id" text,
	"input" text NOT NULL,
	"output" jsonb,
	"reserved_micro" bigint DEFAULT 0 NOT NULL,
	"charged_micro" bigint DEFAULT 0 NOT NULL,
	"provider_cost_usd" numeric(24, 8) DEFAULT '0' NOT NULL,
	"idempotency_key" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_lot_id_credit_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."credit_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "projects_owner_wallet_idx" ON "projects" USING btree ("owner_wallet");--> statement-breakpoint
CREATE INDEX "credit_lots_project_idx" ON "credit_lots" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_tx_log_idx" ON "deposits" USING btree ("chain_tx","log_index");--> statement-breakpoint
CREATE INDEX "ledger_entries_project_idx" ON "ledger_entries" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_project_idx" ON "conversations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_id_version_idx" ON "recipes" USING btree ("id","version");--> statement-breakpoint
CREATE INDEX "run_steps_run_idx" ON "run_steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_project_idx" ON "runs" USING btree ("project_id","created_at");