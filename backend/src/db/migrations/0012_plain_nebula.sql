CREATE TABLE "run_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"slug" text NOT NULL,
	"show_prompt" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "run_shares" ADD CONSTRAINT "run_shares_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_shares" ADD CONSTRAINT "run_shares_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_shares_run_idx" ON "run_shares" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_shares_slug_idx" ON "run_shares" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "run_shares_project_idx" ON "run_shares" USING btree ("project_id","created_at");