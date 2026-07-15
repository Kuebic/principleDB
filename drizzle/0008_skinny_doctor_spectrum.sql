CREATE TABLE "edition" (
	"id" text PRIMARY KEY NOT NULL,
	"work_id" text NOT NULL,
	"label" text NOT NULL,
	"recension" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"published_date" text,
	"publisher" text,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "source" ADD COLUMN "edition_id" text;--> statement-breakpoint
ALTER TABLE "edition" ADD CONSTRAINT "edition_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_edition_id_edition_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."edition"("id") ON DELETE restrict ON UPDATE no action;