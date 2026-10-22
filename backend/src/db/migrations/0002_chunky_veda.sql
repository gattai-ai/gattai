ALTER TABLE "burn_epochs" ADD COLUMN "details" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "burn_epochs_period_idx" ON "burn_epochs" USING btree ("period_start");