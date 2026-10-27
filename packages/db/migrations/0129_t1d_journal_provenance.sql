-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 T1d (Phase 18; G07, G17, SG-11): who approved a journal entry, what
-- produced it, and no system number on a user-typed entry. Owner
-- authorisation 2026-10-24 (evening) item 4: "record the approver on the DRAFT
-- entry in the same transaction, immediately before the draft → posted flip.
-- Do not change G16's rules."
--
-- G16 (0126) is NOT changed. Its flip check allows only `status` and
-- `posted_at` to change at draft → posted, so `approved_by` is written by an
-- UPDATE of the draft before the flip; written IN the flip, G16 refuses it.
--
-- The columns are nullable and NOT back-filled: an entry written before 0129
-- keeps its provenance in its number prefix. Every writer from 0129 on sets
-- `source_type` (and `source_id` unless manual), and `created_by`.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "journal_entries" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "source_id" integer;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "approved_by" integer;--> statement-breakpoint

-- ── The refusing pre-check (forward-only): the new columns arrive EMPTY. ────
-- Anything already in them was written by something other than this migration,
-- and the "no back-fill" statement above would be false. Historical manual
-- entries (the only writer that set `created_by` before 0129) whose numbers use
-- a system shape are COUNTED, not refused: history is not rewritten.
DO $$
DECLARE
  filled int;
  squatted int;
BEGIN
  SELECT count(*) INTO filled FROM journal_entries
   WHERE source_type IS NOT NULL OR source_id IS NOT NULL OR approved_by IS NOT NULL;
  IF filled > 0 THEN
    RAISE EXCEPTION 'T1d pre-check REFUSED: % journal entr(y/ies) already carry source_type, source_id or approved_by; nothing was changed', filled;
  END IF;
  SELECT count(*) INTO squatted FROM journal_entries
   WHERE created_by IS NOT NULL
     AND entry_number ~* '^(GL|BILL|BILLCN|BILLADV|BILLADVCN|DEP|DISP|WO|PAY|VATEV|MIG|OPEN|SPAY|SALLOC|SRECLASS|SREFUND|BTR|TXN|RCPT|ALLOC|UNALLOC|REFUND|RECLASS|ZAKAT|INCTAX|WHTREM|WHTREMREV)-|-REV$';
  RAISE NOTICE 'T1d pre-check: columns empty; % historical manual entr(y/ies) carry a system-shaped number (kept as written)', squatted;
END $$;--> statement-breakpoint

-- 🔴 Hand-written (drizzle does not track CHECKs; the 0071 precedent). Do not drop on a snapshot diff.
-- The list is JOURNAL_SOURCE_TYPES (schema/journalEntries.ts); the T1d proof fails if they drift.
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_type_chk" CHECK (
  source_type IS NULL OR source_type IN (
    'manual', 'recurring', 'reversal',
    'invoice', 'invoice_write_off', 'credit_note_application',
    'customer_payment', 'customer_payment_allocation', 'customer_allocation_correction', 'customer_refund', 'customer_payment_reclassification',
    'bill', 'bill_payment', 'vat_evidence',
    'supplier_payment', 'supplier_advance_allocation', 'supplier_allocation_reversal', 'supplier_payment_reclassification', 'supplier_refund',
    'bank_transfer', 'bank_transaction',
    'payroll_run', 'payroll_net_pay', 'payroll_gosi_payment',
    'depreciation', 'asset_disposal', 'recognition',
    'tax_computation', 'wht_remittance', 'wht_remittance_reversal',
    'migration_opening', 'migration_reversal', 'opening_correction'
  )
);--> statement-breakpoint
-- A manual entry IS its document, and a recurring rule's id is a uuid (its run log links rule and entry):
-- neither has a source id. Every other source names its row.
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_id_chk" CHECK (
  (source_type IS NULL AND source_id IS NULL)
  OR (source_type IN ('manual', 'recurring') AND source_id IS NULL)
  OR (source_type NOT IN ('manual', 'recurring') AND source_id IS NOT NULL)
);--> statement-breakpoint
-- 🔴 SG-11 / G17: a user-written entry (manual, or a recurring rule's draft)
-- never takes a number of a shape the system writes for a document, nor a
-- reversal's `-REV`, in any letter case (RESERVED_ENTRY_NUMBER_PREFIXES).
-- The auto-number `JE-NNNNNN` is a manual entry's own shape, so the service
-- alone refuses it TYPED.
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_manual_number_reserved_chk" CHECK (
  source_type IS NULL OR source_type NOT IN ('manual', 'recurring')
  OR entry_number !~* '^(GL|BILL|BILLCN|BILLADV|BILLADVCN|DEP|DISP|WO|PAY|VATEV|MIG|OPEN|SPAY|SALLOC|SRECLASS|SREFUND|BTR|TXN|RCPT|ALLOC|UNALLOC|REFUND|RECLASS|ZAKAT|INCTAX|WHTREM|WHTREMREV)-|-REV$'
);--> statement-breakpoint

-- 🔴 G07: a manual or recurring entry is posted only by an approval, and the
-- approval records its approver on the draft first. A flip with none recorded
-- is refused at once. (Entries the posting seam writes record their approver
-- when an approval posted them, and none otherwise.) An ordinary trigger: the
-- replica-mode bypass is the only one, as for G16.
CREATE OR REPLACE FUNCTION journal_entries_manual_post_needs_approver() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'posted'
     AND NEW.source_type IN ('manual', 'recurring') AND NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'journal entry % (%) cannot be posted: a % entry is posted by an approval, and no approver is recorded on it', NEW.id, NEW.entry_number, NEW.source_type
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_posted_without_approver';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_entries_manual_post_needs_approver ON "journal_entries";--> statement-breakpoint
CREATE TRIGGER journal_entries_manual_post_needs_approver
  BEFORE UPDATE OF status ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_entries_manual_post_needs_approver();
