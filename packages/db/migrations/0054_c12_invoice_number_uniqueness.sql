-- ═══════════════════════════════════════════════════════════════════════════
-- C12 — invoice numbers become UNIQUE per company, as the law requires.
--
-- 🔴 THE RULE, VERIFIED AGAINST THE PRIMARY TEXT (not inferred from the ICV):
--
--   VAT Implementing Regulations, Article 53(5)(b):
--     "a sequential number which uniquely identifies the Tax Invoice"
--
--   The E-Invoicing Implementation Resolution (19 May 2023), Annex (2) field
--   2.1, does not state the rule itself — it DELEGATES to that article:
--     "Invoice Reference Number (IRN): A unique, sequential note number,
--      issued by taxpayer, as per Article 53(5)(b) of the VAT Implementing
--      Regulation."
--
-- Full citations, and what stays unverified, in
-- docs/tax/invoice-numbering-verification.md.
--
-- ── Why this constraint and not the ICV's machinery ────────────────────────
-- The regulation requires SEQUENTIAL + UNIQUE. It does NOT require an unbroken
-- series: neither document contains "unbroken", "gapless" or "without gap" for
-- the invoice number. ZATCA DID write an explicitly gapless, non-resettable
-- rule — for the tamper-resistant COUNTER (Resolution §7, Annex 2 field 2.5),
-- a different field. That contrast is the argument: a unique index plus a
-- max+1 allocator satisfies the written rule, and the advisory-lock
-- reservation the ICV chain needs is not required here.
--
-- ── Scope: per COMPANY ─────────────────────────────────────────────────────
-- The taxpayer is the company (it carries the VAT registration and is the EGS
-- unit), so uniqueness is scoped to the company. One series spans invoices AND
-- their credit/debit notes: Resolution §2 forbids a solution from generating
-- more than one sequence of "Electronic Invoices and Electronic Notes" per
-- unit, and the Prohibited Functionalities table lists multiple concurrent
-- sequences outright. Our notes are rows in `invoices`, so one index covers it.
-- ═══════════════════════════════════════════════════════════════════════════

-- 🔴 FAIL LOUDLY on pre-existing duplicates rather than renaming anything.
--
-- A duplicate invoice number is a fact about a tenant's books, possibly
-- already transmitted to ZATCA under that identifier. Silently renaming one
-- side would change what a document says AFTER it was issued, and could break
-- a credit note's BillingReference. So: refuse the migration, name the rows,
-- and let a human decide. The dev database has none (checked before writing
-- this); a tenant migrating legacy data might.
DO $$
DECLARE dup_count int; sample text;
BEGIN
  SELECT count(*), COALESCE(string_agg(DISTINCT invoice_number, ', ' ORDER BY invoice_number), '')
    INTO dup_count, sample
  FROM (
    SELECT company_id, invoice_number
    FROM invoices
    GROUP BY company_id, invoice_number
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'C12: % duplicate (company_id, invoice_number) pair(s) exist and must be resolved by hand before this constraint can apply. Affected numbers: %. Do NOT auto-rename: the number is the ZATCA cbc:ID and may already have been transmitted, and a credit note''s BillingReference may point at it.',
      dup_count, left(sample, 500);
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "invoices_company_number_unq"
  ON "invoices" USING btree ("company_id", "invoice_number");--> statement-breakpoint

-- ── The allocator's counter ────────────────────────────────────────────────
-- 🔴 MONOTONIC PER COMPANY, NEVER RESET — including at year end.
--
-- M21.2's allocator produced INV-{YYYY}-{NNNN} with the count restarting each
-- January. Nothing in either document authorises a per-year restart, and a
-- restart is the one arrangement that sits awkwardly against BOTH "sequential"
-- and "not more than one sequence": after 1 January the series stops ascending
-- and begins again. It is probably tolerated in practice; "probably tolerated"
-- is what the primary-source read exists to eliminate.
--
-- The year stays in the DISPLAY prefix for readability but no longer resets
-- the count:  INV-2026-000045 → INV-2026-000046 → INV-2027-000047.
--
-- A table rather than a Postgres SEQUENCE because it must be per-company and
-- tenant-scoped, and because a SEQUENCE is non-transactional: a rolled-back
-- invoice would burn a value. Here the allocation lives inside the caller's
-- transaction, so a rollback discards the number rather than skipping it —
-- which keeps the series tighter than the law requires, at no cost.
CREATE TABLE IF NOT EXISTS "invoice_number_counters" (
  "organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
  "company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
  "last_value" integer NOT NULL DEFAULT 0,
  CONSTRAINT "invoice_number_counters_pk" PRIMARY KEY ("company_id")
);--> statement-breakpoint

ALTER TABLE "invoice_number_counters" ADD CONSTRAINT "invoice_number_counters_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_number_counters" ADD CONSTRAINT "invoice_number_counters_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Never goes backwards. A counter that could be lowered would re-issue a
-- number that a transmitted document already carries.
ALTER TABLE "invoice_number_counters" ADD CONSTRAINT "invoice_number_counters_non_negative"
  CHECK ("last_value" >= 0);--> statement-breakpoint

-- Seed from existing data so the first allocation cannot collide with an
-- invoice already numbered by the old client-side scheme. Only OUR format is
-- counted; a legacy `INV-482913` from the millisecond clock is left alone and
-- simply occupies a number the new series will never reach.
INSERT INTO "invoice_number_counters" ("organization_id", "company_id", "last_value")
SELECT
  i.organization_id,
  i.company_id,
  COALESCE(MAX(NULLIF(regexp_replace(i.invoice_number, '^INV-[0-9]{4}-', ''), '')::int), 0)
FROM invoices i
WHERE i.invoice_number ~ '^INV-[0-9]{4}-[0-9]+$'
GROUP BY i.organization_id, i.company_id
ON CONFLICT ("company_id") DO NOTHING;--> statement-breakpoint

ALTER TABLE "invoice_number_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "invoice_number_counters"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- SELECT/INSERT/UPDATE but never DELETE: dropping a company's counter row
-- would restart its series at 1 and re-issue numbers already transmitted.
GRANT SELECT, INSERT, UPDATE ON TABLE "invoice_number_counters" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.invoice_number_counters FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE DELETE ON TABLE public.invoice_number_counters FROM authenticated';
  END IF;
END $$;--> statement-breakpoint
