CREATE TABLE "leaderboard_opt_outs" (
	"project_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leaderboard_opt_outs" ADD CONSTRAINT "leaderboard_opt_outs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_status_finished_idx" ON "runs" USING btree ("status","finished_at");