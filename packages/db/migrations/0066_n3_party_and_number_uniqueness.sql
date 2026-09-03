-- ═══════════════════════════════════════════════════════════════════════════
-- N3 — PARTY ON THE JOURNAL LINE + DOCUMENT-NUMBER UNIQUENESS (2026-09-03)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Both halves exist because they are CHEAP NOW AND EXPENSIVE LATER, and later
-- is measured: ERPNext retrofitted party onto its GL in 2014 (`be8ec39678`,
-- `patches/v4_2/party_model.py`) with a data migration that rewrote live
-- tenants' balances and a rewrite of reconciliation, advances and the AR/AP
-- reports. We have zero customer rows to backfill today.
--
-- ── HALF 1: party on `journal_entry_lines` ─────────────────────────────────
-- Without a party dimension, GL AR and AR aging are computed from DIFFERENT
-- tables and structurally cannot agree: a manual JE against the AR account
-- moves the balance sheet and is invisible to aging, statements and the
-- customer ledger (ERPNext comparison §1.10). These columns are the dimension;
-- the posting paths populate them; the write-boundary rule lives in
-- `postJournalEntry` (systemCode AR/AP lines must carry a party).
--
-- `party_type` is the discriminator and the CHECK makes an inconsistent row
-- INEXPRESSIBLE: a typed party must name exactly its own id column, and no
-- party means no ids. Plain FKs follow the existing pattern of every other
-- customer/vendor reference (invoices.customer_id etc.); the FK-outside-RLS
-- edge class recorded in §3/§4 applies to them exactly as it does there.
--
-- ── HALF 2: unique (company_id, entry_number) / (company_id, bill_number) ──
-- `0063_document_number_counters.sql` fixed the ALLOCATOR and named the risk
-- it left open: "two financial records that claim to be the same document,
-- silently, in the ledger." The constraint is that missing half. Constructed
-- numbers that could collide are fixed in the same change
-- (`GL-x-PAY-<paymentId>`, `PAY-<period>-R<runId>`, repost suffixes) — the
-- index is what makes any regression LOUD instead of silent.
--
-- 🔴 Existing duplicates are RENAMED, not refused. 0054 refused-and-named for
-- ZATCA invoice numbers because renaming a legally referenced number is not
-- ours to do. JE entry numbers and bill numbers are internal identifiers with
-- no external chain, and refusing would brick every dev database that has
-- exercised partial payments. Each duplicate keeps its first row untouched and
-- later rows gain a deterministic `-D<id>` suffix, RAISE NOTICEd so the rename
-- is visible in the migration log.

-- ── party columns ──────────────────────────────────────────────────────────
ALTER TABLE "journal_entry_lines"
  ADD COLUMN IF NOT EXISTS "party_type" text,
  ADD COLUMN IF NOT EXISTS "customer_id" integer,
  ADD COLUMN IF NOT EXISTS "vendor_id" integer;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jel_customer_fk') THEN
    ALTER TABLE "journal_entry_lines"
      ADD CONSTRAINT "jel_customer_fk" FOREIGN KEY ("customer_id")
      REFERENCES "customers"("id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jel_vendor_fk') THEN
    ALTER TABLE "journal_entry_lines"
      ADD CONSTRAINT "jel_vendor_fk" FOREIGN KEY ("vendor_id")
      REFERENCES "vendors"("id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jel_party_consistency_chk') THEN
    ALTER TABLE "journal_entry_lines"
      ADD CONSTRAINT "jel_party_consistency_chk" CHECK (
        (party_type IS NULL     AND customer_id IS NULL     AND vendor_id IS NULL) OR
        (party_type = 'customer' AND customer_id IS NOT NULL AND vendor_id IS NULL) OR
        (party_type = 'vendor'   AND vendor_id IS NOT NULL   AND customer_id IS NULL)
      );
  END IF;
END $$;--> statement-breakpoint

-- Aging/statement reads will filter by (org, party); index the read shape.
CREATE INDEX IF NOT EXISTS "jel_org_customer_idx"
  ON "journal_entry_lines" ("organization_id", "customer_id") WHERE "customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jel_org_vendor_idx"
  ON "journal_entry_lines" ("organization_id", "vendor_id") WHERE "vendor_id" IS NOT NULL;--> statement-breakpoint

-- ── dedupe, loudly, then constrain ─────────────────────────────────────────
DO $$
DECLARE r record; renamed int := 0;
BEGIN
  FOR r IN
    SELECT id, entry_number FROM (
      SELECT id, entry_number,
             row_number() OVER (PARTITION BY company_id, entry_number ORDER BY id) AS rn
        FROM journal_entries
    ) d WHERE d.rn > 1
  LOOP
    UPDATE journal_entries SET entry_number = entry_number || '-D' || r.id WHERE id = r.id;
    RAISE NOTICE 'N3 dedupe: journal_entries id % renamed to %', r.id, r.entry_number || '-D' || r.id;
    renamed := renamed + 1;
  END LOOP;
  IF renamed > 0 THEN
    RAISE NOTICE 'N3: renamed % duplicate journal entry number(s) — internal identifiers, first occurrence kept', renamed;
  END IF;

  renamed := 0;
  FOR r IN
    SELECT id, bill_number AS entry_number FROM (
      SELECT id, bill_number,
             row_number() OVER (PARTITION BY company_id, bill_number ORDER BY id) AS rn
        FROM bills
    ) d WHERE d.rn > 1
  LOOP
    UPDATE bills SET bill_number = bill_number || '-D' || r.id WHERE id = r.id;
    RAISE NOTICE 'N3 dedupe: bills id % renamed to %', r.id, r.entry_number || '-D' || r.id;
    renamed := renamed + 1;
  END LOOP;
  IF renamed > 0 THEN
    RAISE NOTICE 'N3: renamed % duplicate bill number(s)', renamed;
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "journal_entries_company_number_unq"
  ON "journal_entries" USING btree ("company_id", "entry_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bills_company_number_unq"
  ON "bills" USING btree ("company_id", "bill_number");
