ALTER TYPE "public"."deposit_status" ADD VALUE 'over_cap' BEFORE 'failed';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "onchain_id" text;--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "source" "lot_source";--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "credits_micro" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "lot_id" text;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_lot_id_credit_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."credit_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_onchain_id_idx" ON "projects" USING btree ("onchain_id");--> statement-breakpoint
CREATE INDEX "deposits_project_idx" ON "deposits" USING btree ("project_id","created_at");