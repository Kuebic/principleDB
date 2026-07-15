CREATE TABLE "figure" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	CONSTRAINT "figure_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "work" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"figure_id" text NOT NULL,
	"tier" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source" ADD COLUMN "work_id" text;--> statement-breakpoint
ALTER TABLE "work" ADD CONSTRAINT "work_figure_id_figure_id_fk" FOREIGN KEY ("figure_id") REFERENCES "public"."figure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE restrict ON UPDATE no action;