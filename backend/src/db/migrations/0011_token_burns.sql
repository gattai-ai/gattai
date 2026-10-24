CREATE TYPE "public"."burn_kind" AS ENUM('team', 'epoch', 'community');--> statement-breakpoint
CREATE TABLE "token_burns" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_tx" text NOT NULL,
	"log_index" integer NOT NULL,
	"token_address" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"amount_raw" numeric(78, 0) NOT NULL,
	"decimals" integer DEFAULT 18 NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text,
	"block_timestamp" timestamp with time zone,
	"kind" "burn_kind" NOT NULL,
	"epoch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "token_burns" ADD CONSTRAINT "token_burns_epoch_id_burn_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."burn_epochs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "token_burns_tx_log_idx" ON "token_burns" USING btree ("chain_tx","log_index");--> statement-breakpoint
CREATE INDEX "token_burns_block_idx" ON "token_burns" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "token_burns_kind_idx" ON "token_burns" USING btree ("kind","block_timestamp");