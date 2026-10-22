DROP INDEX "projects_owner_wallet_idx";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "is_trial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Perbaikan data SEBELUM index dibuat unik. Sampai sekarang
-- `projects_owner_wallet_idx` hanyalah index biasa, jadi balapan antara dua
-- login SIWE untuk wallet yang sama bisa meninggalkan dua baris `projects`.
-- Drizzle tidak mengizinkan `CREATE UNIQUE INDEX` selama duplikat ada, jadi
-- duplikat harus dibereskan lebih dulu: seluruh baris anak dipindahkan ke
-- project penyintas (baris tertua per wallet), lalu duplikatnya dihapus.
--
-- Urutannya penting: pindahkan anak → rapikan saldo berjalan → baru hapus
-- duplikat. Setelah duplikat terhapus, CTE penghitung tidak lagi menemukannya.
WITH ranked AS (
  SELECT
    id AS dupe_id,
    first_value(id) OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS survivor_id,
    row_number() OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS rn
  FROM "projects"
)
UPDATE "runs" AS child SET project_id = ranked.survivor_id
FROM ranked
WHERE child.project_id = ranked.dupe_id AND ranked.rn > 1;--> statement-breakpoint
WITH ranked AS (
  SELECT
    id AS dupe_id,
    first_value(id) OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS survivor_id,
    row_number() OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS rn
  FROM "projects"
)
UPDATE "api_keys" AS child SET project_id = ranked.survivor_id
FROM ranked
WHERE child.project_id = ranked.dupe_id AND ranked.rn > 1;--> statement-breakpoint
WITH ranked AS (
  SELECT
    id AS dupe_id,
    first_value(id) OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS survivor_id,
    row_number() OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS rn
  FROM "projects"
)
UPDATE "conversations" AS child SET project_id = ranked.survivor_id
FROM ranked
WHERE child.project_id = ranked.dupe_id AND ranked.rn > 1;--> statement-breakpoint
WITH ranked AS (
  SELECT
    id AS dupe_id,
    first_value(id) OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS survivor_id,
    row_number() OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS rn
  FROM "projects"
)
UPDATE "credit_lots" AS child SET project_id = ranked.survivor_id
FROM ranked
WHERE child.project_id = ranked.dupe_id AND ranked.rn > 1;--> statement-breakpoint
WITH ranked AS (
  SELECT
    id AS dupe_id,
    first_value(id) OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS survivor_id,
    row_number() OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS rn
  FROM "projects"
)
UPDATE "ledger_entries" AS child SET project_id = ranked.survivor_id
FROM ranked
WHERE child.project_id = ranked.dupe_id AND ranked.rn > 1;--> statement-breakpoint
WITH ranked AS (
  SELECT
    id AS dupe_id,
    first_value(id) OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS survivor_id,
    row_number() OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS rn
  FROM "projects"
)
UPDATE "deposits" AS child SET project_id = ranked.survivor_id
FROM ranked
WHERE child.project_id = ranked.dupe_id AND ranked.rn > 1;--> statement-breakpoint
-- `balance_after_micro` adalah saldo berjalan per project (audit). Setelah
-- digabung, entri dari project duplikat ikut menyusun urutan baru, jadi nilai
-- lamanya tidak lagi menggambarkan saldo pada titik waktu itu. Hitung ulang
-- HANYA untuk project yang benar-benar menerima gabungan.
WITH ranked AS (
  SELECT
    first_value(id) OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS survivor_id,
    row_number() OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS rn
  FROM "projects"
),
survivors AS (SELECT DISTINCT survivor_id FROM ranked WHERE rn > 1),
ordered AS (
  SELECT
    le.id,
    sum(le.amount_micro) OVER (
      PARTITION BY le.project_id
      ORDER BY le.created_at, le.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running_micro
  FROM "ledger_entries" AS le
  JOIN survivors AS s ON s.survivor_id = le.project_id
)
UPDATE "ledger_entries" AS le SET balance_after_micro = ordered.running_micro
FROM ordered
WHERE le.id = ordered.id AND le.balance_after_micro <> ordered.running_micro;--> statement-breakpoint
DELETE FROM "projects" AS p
USING (
  SELECT
    id AS dupe_id,
    row_number() OVER (PARTITION BY owner_wallet ORDER BY created_at, id) AS rn
  FROM "projects"
) AS ranked
WHERE p.id = ranked.dupe_id AND ranked.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_owner_wallet_idx" ON "projects" USING btree ("owner_wallet");
