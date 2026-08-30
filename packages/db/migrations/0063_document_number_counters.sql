-- 0063 — a per-company counter for the OTHER document numbers.
--
-- ── 🔴 WHY THIS EXISTS: THE SWEEP AFTER AUD-1 ──────────────────────────────
-- AUD-1 found the browser minting invoice numbers from a clock
-- (`CN-${Date.now().toString().slice(-6)}`) and fixed invoices and credit notes
-- by letting the server's C12 counter allocate. It did not sweep the shape.
--
-- The sweep found FIVE instances of the same mint, of which the fix had covered
-- two:
--
--   JournalEntries.tsx   JE-${Date.now().slice(-6)}     ledger-facing
--   Bills.tsx            BILL-${Date.now().slice(-6)}   ledger-facing
--   ScanReview.tsx       BILL-${Date.now().slice(-6)}   ledger-facing
--   Assets.tsx           FA-${Date.now().slice(-5)}     reference
--   Employees.tsx        EMP-${Date.now().slice(-5)}    reference
--
-- 🔴 And these are WORSE than the invoice case was. `slice(-6)` keeps the last
-- six digits of a millisecond clock, so it wraps every ~16.7 minutes — and
-- unlike `invoices`, NONE of these columns carries a unique index. A collision
-- on an invoice number was refused by the database. A collision on an entry or
-- bill number is simply accepted, producing two financial records that claim to
-- be the same document, silently, in the ledger.
--
-- This table is the counter for the ledger-facing two. `document_type` keeps
-- one series per company per type — deliberately NOT one shared series, because
-- unlike ZATCA's invoice/note rule (C12) nothing requires journal entries and
-- bills to interleave, and one series per type is what a reader expects.
--
-- Assets and employees keep their prefills for now: those numbers identify a
-- thing, not a posting, and giving them a server series is a separate decision.
-- Their collision risk is recorded rather than silently accepted.

CREATE TABLE IF NOT EXISTS "document_number_counters" (
  "organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
  "company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
  "document_type" text NOT NULL,
  "last_value" integer NOT NULL DEFAULT 0,
  CONSTRAINT "document_number_counters_pk" PRIMARY KEY ("company_id", "document_type")
);--> statement-breakpoint

ALTER TABLE "document_number_counters" ADD CONSTRAINT "document_number_counters_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- CASCADE on the company, and only on the company — the same reasoning as 0054.
ALTER TABLE "document_number_counters" ADD CONSTRAINT "document_number_counters_company_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Never goes backwards: a counter that could be lowered would re-issue a number
-- already used by a posted document.
ALTER TABLE "document_number_counters" ADD CONSTRAINT "document_number_counters_non_negative"
  CHECK ("last_value" >= 0);--> statement-breakpoint

ALTER TABLE "document_number_counters" ADD CONSTRAINT "document_number_counters_known_type"
  CHECK ("document_type" IN ('journal_entry', 'bill'));--> statement-breakpoint

-- 🔴 Seed from existing data so the first allocation cannot collide with a
-- number a tenant is already using. Only counter-shaped numbers participate;
-- anything hand-typed or imported is the caller's own series and is left alone.
INSERT INTO "document_number_counters" ("organization_id", "company_id", "document_type", "last_value")
SELECT je.organization_id, je.company_id, 'journal_entry',
       COALESCE(MAX(NULLIF(regexp_replace(je.entry_number, '^JE-', ''), '')::bigint), 0)
FROM journal_entries je
WHERE je.entry_number ~ '^JE-[0-9]+$' AND je.company_id IS NOT NULL
GROUP BY je.organization_id, je.company_id
ON CONFLICT ("company_id", "document_type") DO NOTHING;--> statement-breakpoint

INSERT INTO "document_number_counters" ("organization_id", "company_id", "document_type", "last_value")
SELECT b.organization_id, b.company_id, 'bill',
       COALESCE(MAX(NULLIF(regexp_replace(b.bill_number, '^BILL-', ''), '')::bigint), 0)
FROM bills b
WHERE b.bill_number ~ '^BILL-[0-9]+$' AND b.company_id IS NOT NULL
GROUP BY b.organization_id, b.company_id
ON CONFLICT ("company_id", "document_type") DO NOTHING;--> statement-breakpoint

ALTER TABLE "document_number_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "document_number_counters"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- SELECT/INSERT/UPDATE but never DELETE: dropping a counter row restarts the
-- series and re-issues numbers already on posted documents.
GRANT SELECT, INSERT, UPDATE ON TABLE "document_number_counters" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.document_number_counters FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE DELETE ON TABLE public.document_number_counters FROM authenticated';
  END IF;
END $$;
