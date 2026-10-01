-- Phase 14 D14-15 — two indexes for the report ledger seam, chosen from MEASURED plans
-- (docs/product/phase-14-15-reporting-budgeting-decision-pack.md D14-15).
--
-- 1. journal_entries ((company_id::text), date): the seam filters on the company exactly as
--    companyScoped() and the RLS company arm write it (company_id::text = current_setting(...)),
--    which a plain index on the uuid column cannot serve; plus the accounting date every report
--    bounds. Measured at 300k lines (synthetic, rolled back): a one-month P&L went from a seq scan of
--    every tenant's lines (125k buffers, 104 ms) to 3.3k buffers / 12 ms.
-- 2. journal_entry_lines (journal_entry_id): the entries -> lines join probe; the org-led
--    index cannot serve a probe on journal_entry_id alone.
--
-- Indexes only: no row, grant or policy changes. Fresh-DB safe (plain CREATE INDEX on existing columns).
CREATE INDEX "journal_entries_company_text_date_idx" ON "journal_entries" USING btree (("company_id"::text),"date");--> statement-breakpoint
CREATE INDEX "journal_entry_lines_entry_idx" ON "journal_entry_lines" USING btree ("journal_entry_id");