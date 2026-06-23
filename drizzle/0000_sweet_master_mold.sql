CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "principle" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"claim" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"distil_model" text NOT NULL,
	"distil_model_version" text NOT NULL,
	"distil_prompt_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote" (
	"id" text PRIMARY KEY NOT NULL,
	"principle_id" text NOT NULL,
	"source_id" text NOT NULL,
	"span_start" integer NOT NULL,
	"span_end" integer NOT NULL,
	"located" boolean NOT NULL,
	"match_tier" text NOT NULL,
	"distil_prompt_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_candidate" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"claim" text NOT NULL,
	"quote_text" text NOT NULL,
	"match_tier" text NOT NULL,
	"dedup_state" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"author" text NOT NULL,
	"kind" text NOT NULL,
	"date" text NOT NULL,
	"text" text NOT NULL,
	"r2_key" text,
	"structure_map" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "principle" ADD CONSTRAINT "principle_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote" ADD CONSTRAINT "quote_principle_id_principle_id_fk" FOREIGN KEY ("principle_id") REFERENCES "public"."principle"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote" ADD CONSTRAINT "quote_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_candidate" ADD CONSTRAINT "review_candidate_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;