CREATE UNIQUE INDEX "wht_return_filings_reference_unq" ON "wht_return_filings" USING btree ("company_id","period","zatca_reference");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- 0119 — THE FINAL AUDIT'S DATABASE FIXES (2026-10-05; pack phase-16-17 §15)
--
--   SEC-4  the index above: a ZATCA acknowledgement names ONE filing of a month —
--          the same reference again is the same filing replayed, never a false
--          (and, filings being append-only, permanent) amendment.
--   SEC-1  the three WHT return functions the APP calls run with the CALLER's
--          rights: RLS decides what they read, so another company's id answers
--          0 (the isolation contract of `input_vat_journal_owner`). They ran as
--          their owner (RLS bypassed) and returned another tenant's figures.
--          The admit triggers that call them are SECURITY DEFINER themselves, so
--          what THEY read is unchanged.
--   MG-1   a depreciation posting reads its asset FOR SHARE, so it serialises
--          with a migration reversal (which locks the batch's assets FOR UPDATE
--          before reading what was depreciated): never a reversed asset with an
--          unmirrored charge. Now caller's rights too (SEC-2): under RLS a
--          foreign asset reads as missing and is refused.
--   MG-2   a MIRROR is never itself reversed, and a migration's own entries
--          (opening, opening correction, its reversal) are mirrored only by the
--          migration's reversal (source 'opening_reversal') — so the generic
--          reverse cannot resurrect a withdrawn opening position, nor
--          re-depreciate a reversed asset.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── SEC-1 ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION wht_return_tax(p_company_id uuid, p_period text) RETURNS numeric
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT sum(w.wht_amount) FROM wht_withholdings w
                    WHERE w.company_id = p_company_id AND w.return_period = p_period AND w.status = 'withheld'), 0)
       - coalesce((SELECT sum(w.wht_amount) FROM wht_corrections c JOIN wht_withholdings w ON w.id = c.withholding_id
                    WHERE c.company_id = p_company_id AND c.reversal_return_period = p_period AND w.status = 'withheld'), 0)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION wht_return_base(p_company_id uuid, p_period text) RETURNS numeric
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT sum(w.base_amount) FROM wht_withholdings w
                    WHERE w.company_id = p_company_id AND w.return_period = p_period AND w.status = 'withheld'), 0)
       - coalesce((SELECT sum(w.base_amount) FROM wht_corrections c JOIN wht_withholdings w ON w.id = c.withholding_id
                    WHERE c.company_id = p_company_id AND c.reversal_return_period = p_period AND w.status = 'withheld'), 0)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION wht_unremitted(p_company_id uuid, p_period text) RETURNS numeric
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_period IS NULL THEN
           coalesce((SELECT sum(l.credit_amount - l.debit_amount) FROM journal_entry_lines l
                       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
                      WHERE e.company_id = p_company_id AND c.system_code = 'WHT_PAYABLE' AND e.status IN ('posted', 'reversed')
                        AND e.source IN ('opening', 'opening_reversal', 'opening_correction')), 0)
         ELSE wht_return_tax(p_company_id, p_period)
         END
       - coalesce((SELECT sum(r.amount) FROM wht_remittances r
                    WHERE r.company_id = p_company_id AND r.period IS NOT DISTINCT FROM p_period
                      AND NOT EXISTS (SELECT 1 FROM wht_remittance_reversals x WHERE x.remittance_id = r.id)), 0)
$$;--> statement-breakpoint

-- ── MG-1 (+ SEC-2) ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION depreciation_refused_out_of_books() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE st text;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.journal_entry_id IS NULL AND NEW.journal_entry_id IS NOT NULL) THEN RETURN NEW; END IF;
  -- FOR SHARE: waits for a migration reversal holding the asset FOR UPDATE, then reads what it committed
  SELECT status INTO st FROM fixed_assets WHERE id = NEW.asset_id FOR SHARE;
  IF st IS NULL OR st IN ('reversed', 'disposed', 'cancelled') THEN
    RAISE EXCEPTION 'asset % is %: an asset out of the books is never depreciated (planned or posted)', NEW.asset_id, coalesce(st, 'missing')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'depreciation_asset_out_of_books';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ── MG-2 ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION journal_entries_mirror_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t record;
BEGIN
  SELECT id, organization_id, company_id, reversal_of, source, entry_number INTO t FROM journal_entries WHERE id = NEW.reversal_of;
  -- one answer for "another tenant's" and "no such entry": no existence oracle
  IF t.id IS NULL OR t.organization_id IS DISTINCT FROM NEW.organization_id OR t.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'journal entry %: the entry it reverses (%) is not in this organisation and company', NEW.entry_number, NEW.reversal_of
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_reversal_tenant';
  END IF;
  IF t.reversal_of IS NOT NULL THEN
    RAISE EXCEPTION 'journal entry %: entry % is itself a reversal; a reversal is never reversed (it would re-post what it undid)', NEW.entry_number, t.entry_number
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_mirror_not_reversible';
  END IF;
  IF t.source IN ('opening', 'opening_correction', 'opening_reversal') AND NEW.source IS DISTINCT FROM 'opening_reversal' THEN
    RAISE EXCEPTION 'journal entry %: entry % belongs to a migration batch; only the batch''s reversal mirrors it', NEW.entry_number, t.entry_number
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_migration_owned';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION journal_entries_mirror_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER journal_entries_mirror_admit BEFORE INSERT ON "journal_entries"
  FOR EACH ROW WHEN (NEW.reversal_of IS NOT NULL) EXECUTE FUNCTION journal_entries_mirror_admit();
