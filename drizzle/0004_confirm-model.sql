-- issue #24 / PRD #21: decouple confirm model from distil model.
-- Backfill existing rows with `claude-opus-4-8` — the implicit confirm model
-- before this change was the same as the distil model, and the distil
-- default has always been Opus. Drop the default so future inserts must
-- stamp `confirm_model` explicitly.
ALTER TABLE "dedup_decision" ADD COLUMN "confirm_model" text NOT NULL DEFAULT 'claude-opus-4-8';--> statement-breakpoint
ALTER TABLE "dedup_decision" ALTER COLUMN "confirm_model" DROP DEFAULT;