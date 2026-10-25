DROP INDEX "holder_cost_ledger_run_idx";--> statement-breakpoint
ALTER TABLE "holder_fee_allocations" ALTER COLUMN "amount_usd" SET DATA TYPE numeric(24, 8);--> statement-breakpoint
-- Pertahankan satu baris audit per run sebelum memasang unique index.
DELETE FROM "holder_cost_ledger" AS a
USING "holder_cost_ledger" AS b
WHERE a."run_id" = b."run_id"
	AND (a."created_at", a."id") > (b."created_at", b."id");--> statement-breakpoint
CREATE UNIQUE INDEX "holder_cost_ledger_run_idx" ON "holder_cost_ledger" USING btree ("run_id");