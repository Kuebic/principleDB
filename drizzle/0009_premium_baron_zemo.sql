ALTER TABLE "source" DROP CONSTRAINT "source_work_id_work_id_fk";
--> statement-breakpoint
ALTER TABLE "source" ALTER COLUMN "edition_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "source" DROP COLUMN "work_id";