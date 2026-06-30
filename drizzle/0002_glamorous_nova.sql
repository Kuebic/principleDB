CREATE TABLE "bulk_progress" (
	"phase" text NOT NULL,
	"source_id" text NOT NULL,
	CONSTRAINT "bulk_progress_phase_source_id_pk" PRIMARY KEY("phase","source_id")
);
