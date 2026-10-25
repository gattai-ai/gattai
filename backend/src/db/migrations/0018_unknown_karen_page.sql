CREATE TABLE "holder_worker_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_cycle_started_at" timestamp with time zone,
	"last_cycle_finished_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_scanned" integer DEFAULT 0 NOT NULL,
	"last_recorded" integer DEFAULT 0 NOT NULL,
	"last_skipped" integer DEFAULT 0 NOT NULL,
	"last_errors" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
