ALTER TABLE "conversations" ALTER COLUMN "title" SET DEFAULT 'New chat';--> statement-breakpoint
UPDATE "conversations" SET "title" = 'New chat' WHERE "title" IS NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "title" SET NOT NULL;