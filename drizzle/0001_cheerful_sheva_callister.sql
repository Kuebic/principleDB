CREATE TABLE "dedup_decision" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"candidate_claim" text NOT NULL,
	"existing_principle_id" text,
	"verdict" text NOT NULL,
	"rationale" text NOT NULL,
	"similarity_score" double precision NOT NULL,
	"distil_model" text NOT NULL,
	"distil_model_version" text NOT NULL,
	"distil_prompt_version" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dedup_decision" ADD CONSTRAINT "dedup_decision_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedup_decision" ADD CONSTRAINT "dedup_decision_existing_principle_id_principle_id_fk" FOREIGN KEY ("existing_principle_id") REFERENCES "public"."principle"("id") ON DELETE set null ON UPDATE no action;