-- Bersihkan snapshot duplikat dari block yang sama sebelum memasang unique
-- index. Yang dipertahankan adalah baris dengan (taken_at, id) terkecil,
-- yaitu snapshot pertama yang tercatat.
DELETE FROM "holder_snapshots" AS a
USING "holder_snapshots" AS b
WHERE a."wallet" = b."wallet"
	AND a."block_number" = b."block_number"
	AND (a."taken_at", a."id") > (b."taken_at", b."id");--> statement-breakpoint
CREATE UNIQUE INDEX "holder_snapshots_wallet_block_idx" ON "holder_snapshots" USING btree ("wallet","block_number");