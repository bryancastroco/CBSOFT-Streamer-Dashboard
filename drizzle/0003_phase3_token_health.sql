-- Phase 3 — token health.
--
-- Replaces the Phase 2 `token_status` values with the six the specification
-- defines, plus `missing` for "no token stored", and adds two columns for the
-- validation result.
--
-- The check constraint `streamers_token_consistency_check` compares
-- `token_status` against literals, so it must be dropped BEFORE the type is
-- swapped and recreated afterwards. Leaving it in place fails with
-- `operator does not exist: text = token_status`, because the constraint
-- expression is frozen against the old type while the column moves to the new
-- one. Likewise the column default must be dropped before the type changes.

ALTER TABLE "streamers" DROP CONSTRAINT IF EXISTS "streamers_token_consistency_check";--> statement-breakpoint
ALTER TABLE "streamers" ALTER COLUMN "token_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "streamers" ALTER COLUMN "token_status" SET DATA TYPE text;--> statement-breakpoint

-- Carry any Phase 2 values across to their Phase 3 equivalents. The table is
-- empty on every environment today; this exists so the migration is still
-- correct if it is ever run against one that is not.
UPDATE "streamers" SET "token_status" = 'valid'   WHERE "token_status" = 'active';--> statement-breakpoint
UPDATE "streamers" SET "token_status" = 'invalid' WHERE "token_status" = 'revoked';--> statement-breakpoint

DROP TYPE "public"."token_status";--> statement-breakpoint
CREATE TYPE "public"."token_status" AS ENUM('missing', 'valid', 'expiring', 'expired', 'invalid', 'missing_permission', 'unknown');--> statement-breakpoint

ALTER TABLE "streamers" ALTER COLUMN "token_status" SET DATA TYPE "public"."token_status" USING "token_status"::"public"."token_status";--> statement-breakpoint
ALTER TABLE "streamers" ALTER COLUMN "token_status" SET DEFAULT 'missing'::"public"."token_status";--> statement-breakpoint

ALTER TABLE "streamers" ADD CONSTRAINT "streamers_token_consistency_check" CHECK (("streamers"."encrypted_page_token" is null and "streamers"."page_token_last_four" is null and "streamers"."token_status" = 'missing')
        or ("streamers"."encrypted_page_token" is not null and "streamers"."page_token_last_four" is not null and "streamers"."token_status" <> 'missing'));--> statement-breakpoint

ALTER TABLE "streamers" ADD COLUMN "token_last_validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "streamers" ADD COLUMN "token_validation_error" text;--> statement-breakpoint

-- Phase 2 grants privileges on `streamers` column by column, precisely so that
-- `encrypted_page_token` is excluded. A column added later therefore starts with
-- NO grant at all, which is the safe default — but these two are operator-facing
-- token health, not secrets, so they are granted explicitly.
GRANT SELECT ("token_last_validated_at", "token_validation_error") ON "streamers" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("token_last_validated_at", "token_validation_error") ON "streamers" TO authenticated;
