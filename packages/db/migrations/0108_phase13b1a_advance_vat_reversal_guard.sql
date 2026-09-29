-- PHASE 13B-1a — supplier advance VAT entries under the generic-reversal guard (2026-09-29).
-- Record: docs/product/phase-13b2-credit-note-event-design.md §16A (D-2).
--
-- 🔴 THE DEFECT (found after 13B-1 merged): input_vat_journal_owner() (0107)
-- recognised a bill-owned entry only by `LIKE 'BILLCN-%'` / `LIKE 'BILL-%'`.
-- A supplier advance invoice posts `BILLADV-<n>` and an advance credit note
-- `BILLADVCN-<n>` (supplierAdvanceInvoices.service.ts): their fifth character
-- is `A`, not `-`, so neither pattern matched, the bill-number CASE returned
-- NULL, and the owner was NULL. Both layers read this ONE function — the
-- service's documentOwner and the trigger guards — so both let the generic
-- journal reverse cancel an advance invoice's VAT claim (or its credit note's
-- reversal of it) while the document read live. A-5 covered bill and
-- supplier-note entries; an advance invoice IS a bill and an advance credit
-- note IS a supplier note, so this is a 13B-1 scope defect.
--
-- THE FIX: the same function, one definition, extended to the two prefixes,
-- each matched against the posted document of the RIGHT type. Nothing else
-- changes: journal_entries_vat_reversal_guard and journal_entry_lines_vat_guard
-- (0107) read input_vat_journal_protected(), which reads this function, so
-- both database guards cover the new owners with no trigger change. No event
-- writer, no accounting meaning, no journal, no VAT return is touched.
--
-- The four prefixes are disjoint: 'BILLADVCN-…' has 'C' where 'BILLADV-%'
-- needs '-', and neither 'BILLCN-%' nor 'BILL-%' can match an advance prefix
-- (their 5th character is 'C' / '-', an advance entry's is 'A').
CREATE OR REPLACE FUNCTION input_vat_journal_owner(p_entry_id integer) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM input_vat_events v WHERE v.journal_entry_id = p_entry_id) THEN 'input_vat_event'
    WHEN EXISTS (SELECT 1 FROM bills b WHERE b.input_vat_claim_entry_id = p_entry_id) THEN 'bill_vat_claim'
    ELSE (SELECT CASE WHEN e.entry_number LIKE 'BILLADVCN-%' THEN 'advance_credit_note'
                      WHEN e.entry_number LIKE 'BILLADV-%'   THEN 'advance_invoice'
                      WHEN e.entry_number LIKE 'BILLCN-%'    THEN 'supplier_note'
                      ELSE 'bill' END
            FROM journal_entries e
            JOIN bills b ON b.company_id = e.company_id
                        AND b.bill_number = CASE WHEN e.entry_number LIKE 'BILLADVCN-%' THEN substr(e.entry_number, 11)
                                                 WHEN e.entry_number LIKE 'BILLADV-%'   THEN substr(e.entry_number, 9)
                                                 WHEN e.entry_number LIKE 'BILLCN-%'    THEN substr(e.entry_number, 8)
                                                 WHEN e.entry_number LIKE 'BILL-%'      THEN substr(e.entry_number, 6) END
                        -- An advance prefix names an advance document, and only that.
                        AND (e.entry_number NOT LIKE 'BILLADVCN-%' OR b.document_type = 'advance_credit_note')
                        AND (e.entry_number NOT LIKE 'BILLADV-%'   OR b.document_type = 'advance_invoice')
           WHERE e.id = p_entry_id
             AND b.status NOT IN ('draft', 'submitted')
           LIMIT 1)
  END
$$;--> statement-breakpoint
-- CREATE OR REPLACE keeps a function's privileges; restated so the grant is
-- visible here, exactly as 0107 set it (callable by the app, under RLS).
REVOKE ALL ON FUNCTION input_vat_journal_owner(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION input_vat_journal_owner(integer) TO authenticated;
