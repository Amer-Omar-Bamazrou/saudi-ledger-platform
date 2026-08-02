-- M11.2 · Verification gate columns on `organizations`.
--
-- CRITICAL backfill: every EXISTING organization must be grandfathered to
-- `approved` so the seeded default tenant and all M3-backfilled data keep full
-- access — a pre-existing org was never subject to signup verification. Only
-- NEW rows (real self-service signups from M11.5) start as `pending_review`.
--
-- We achieve both with a two-step default: add the column with a transient
-- DEFAULT 'approved' (which fills all existing rows), THEN switch the default to
-- 'pending_review' for all future inserts. (The seed additionally sets the
-- default org 'approved' explicitly, belt-and-suspenders.)
ALTER TABLE "organizations" ADD COLUMN "verification_status" varchar(30) DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "verification_status" SET DEFAULT 'pending_review';--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "verification_reason" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "verification_reviewed_by" integer;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "verification_reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "verification_submitted_at" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_verification_reviewed_by_users_id_fk" FOREIGN KEY ("verification_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
