-- Phase 14 D14-15 — two indexes for the report ledger seam, chosen from MEASURED plans
-- (docs/product/phase-14-15-reporting-budgeting-decision-pack.md D14-15).
--
-- 1. journal_entries (company_id, date): the seam scopes the company with the TYPED predicate
--    `company_id = nullif(current_setting('app.current_company_id', true), '')::uuid`
--    (repositories/companyScope.ts). Measured AS THE TENANT ROLE under RLS: the earlier
--    `company_id::text` form could not become an index condition (its functions are not
--    leakproof), so it scanned every tenant; the typed form is an Index Cond on both columns.
-- 2. journal_entry_lines (journal_entry_id): the entries -> lines join probe; the org-led
--    index cannot serve a probe on journal_entry_id alone.
--
-- Indexes only: no row, grant or policy change. Fresh-DB safe (plain CREATE INDEX on existing columns).
CREATE INDEX "journal_entries_company_date_idx" ON "journal_entries" USING btree ("company_id","date");--> statement-breakpoint
CREATE INDEX "journal_entry_lines_entry_idx" ON "journal_entry_lines" USING btree ("journal_entry_id");