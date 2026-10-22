ALTER TYPE "public"."deposit_status" ADD VALUE 'dust';--> statement-breakpoint
ALTER TYPE "public"."deposit_status" ADD VALUE 'needs_review';--> statement-breakpoint
ALTER TYPE "public"."deposit_status" ADD VALUE 'reorged';--> statement-breakpoint
CREATE TABLE "chain_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"block_number" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposit_dead_letters" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_tx" text NOT NULL,
	"log_index" integer NOT NULL,
	"project_id" text,
	"payer" text,
	"token" text,
	"amount_raw" text,
	"error" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "block_number" bigint;--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "block_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_dead_letters_tx_log_idx" ON "deposit_dead_letters" USING btree ("chain_tx","log_index");--> statement-breakpoint
CREATE INDEX "deposit_dead_letters_created_idx" ON "deposit_dead_letters" USING btree ("created_at");