ALTER TABLE "runs" DROP CONSTRAINT "runs_idempotency_key_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_project_idempotency_idx" ON "runs" USING btree ("project_id","idempotency_key");