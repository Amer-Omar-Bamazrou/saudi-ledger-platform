ALTER TABLE "einvoice_documents" ADD COLUMN "zatca_uuid" uuid;--> statement-breakpoint
-- Already dropped by hand in 0022; drizzle re-emits it because 0022's snapshot
-- predates the schema edit. IF EXISTS makes the two agree without a second
-- destructive statement.
ALTER TABLE "companies" DROP COLUMN IF EXISTS "zatca_onboarding_status";--> statement-breakpoint

-- Back-fill from the invoice each document belongs to. Nullable rather than NOT
-- NULL: a pre-existing document whose invoice predates ZATCA UUID assignment has
-- no correct value, and the worker now refuses to submit a document without one
-- rather than sending a wrong id (which is what it did before).
UPDATE "einvoice_documents" d
   SET "zatca_uuid" = i."zatca_uuid"
  FROM "invoices" i
 WHERE i."id" = d."invoice_id"
   AND d."zatca_uuid" IS NULL
   AND i."zatca_uuid" IS NOT NULL;
