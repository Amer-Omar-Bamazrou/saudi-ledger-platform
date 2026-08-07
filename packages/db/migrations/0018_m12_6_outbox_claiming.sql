-- M12.6 · Outbox worker claiming.
--
-- claimed_at / claimed_by: set by the FOR UPDATE SKIP LOCKED claim. A row stuck
-- in `submitting` with a stale claimed_at means a worker died mid-flight.
--
-- ambiguous: TRUE when a submission failed leaving ZATCA state UNKNOWN (timeout,
-- connection reset). This is what makes blind retry unsafe — resubmitting a
-- document ZATCA already accepted risks a duplicate, and abandoning one they
-- never received strands a consumed ICV in a legally-required sequence. Such
-- rows are reconciled by ASKING ZATCA, never by guessing.

ALTER TABLE "einvoice_documents" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "einvoice_documents" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "einvoice_documents" ADD COLUMN "ambiguous" boolean DEFAULT false NOT NULL;
