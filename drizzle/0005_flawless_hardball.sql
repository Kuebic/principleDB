CREATE TABLE "staged_source" (
	"source_id" text NOT NULL,
	"distil_model" text NOT NULL,
	"distil_model_version" text NOT NULL,
	"distil_prompt_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "staged_source_source_id_distil_model_distil_model_version_distil_prompt_version_pk" PRIMARY KEY("source_id","distil_model","distil_model_version","distil_prompt_version")
);
