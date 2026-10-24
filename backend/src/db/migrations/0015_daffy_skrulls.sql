CREATE TABLE "holder_cost_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"wallet" text NOT NULL,
	"tier" text NOT NULL,
	"cost_usd" numeric(24, 8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holder_fee_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"tx_hash" text,
	"amount_usd" numeric(24, 6) NOT NULL,
	"source" text DEFAULT 'pons_fee_split' NOT NULL,
	"notes" text,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holder_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"balance_raw" text NOT NULL,
	"balance_tokens" numeric(28, 4) NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "is_holder" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "holder_tier" text;--> statement-breakpoint
ALTER TABLE "holder_cost_ledger" ADD CONSTRAINT "holder_cost_ledger_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holder_cost_ledger" ADD CONSTRAINT "holder_cost_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holder_cost_ledger_wallet_idx" ON "holder_cost_ledger" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "holder_cost_ledger_created_idx" ON "holder_cost_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "holder_cost_ledger_run_idx" ON "holder_cost_ledger" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "holder_fee_allocations_allocated_idx" ON "holder_fee_allocations" USING btree ("allocated_at");--> statement-breakpoint
CREATE INDEX "holder_snapshots_wallet_taken_idx" ON "holder_snapshots" USING btree ("wallet","taken_at");--> statement-breakpoint
CREATE INDEX "holder_snapshots_taken_idx" ON "holder_snapshots" USING btree ("taken_at");--> statement-breakpoint
CREATE INDEX "runs_project_holder_idx" ON "runs" USING btree ("project_id","is_holder","created_at");