import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * 🔴 N1 — THE COMPANY PREDICATE, AS ONE SEAM (2026-09-03).
 *
 * Two companies in one organization are separate sets of books, and until N1
 * nothing below the repositories enforced that on reads: fifteen repositories
 * queried company-scoped tables with no company filter, so a two-company org's
 * trial balance, GL, income statement, balance sheet and VAT return ADDED BOTH
 * COMPANIES' BOOKS — reported as `balanced: true`, because two balanced books
 * sum to a balanced book. Record:
 * `docs/history/erpnext-comparison-2026-09-03.md`, Part 1 §1.
 *
 * N1 closes it in two layers that must AGREE on the scoped case and DISAGREE
 * loudly on the misconfigured one:
 *
 *  1. Migration 0065 — every `tenant_isolation` policy on a table carrying
 *     `company_id` scopes rows to `app.current_company_id` when the GUC is
 *     set, and stays org-wide when it is empty (the findings scheduler's
 *     deliberate org-wide pass).
 *  2. THIS predicate, ANDed into the report repositories' shared condition
 *     builders — the inherit-the-filter position (ERPNext's
 *     `get_accounting_entries`): a new report method composed from the shared
 *     builders is scoped without its author doing anything.
 *
 * 🔴 The two layers differ ON PURPOSE when the company GUC is empty: RLS reads
 * org-wide (the scheduler's semantic); this predicate matches NOTHING. So a
 * request that somehow reaches a report without a company produces an EMPTY
 * report — visible, complainable — never a doubled one that reads as an
 * answer. `checkPeriodOpen` (periodLock.ts) uses the same GUC the same way,
 * so a lock and a report always agree about which company they mean.
 *
 * One seam, not a per-file idiom: the GL-tolerance lesson (`glPosting.ts`) is
 * that one invariant expressed as two constants drifts. Every repository that
 * scopes reads by company imports THIS function.
 */
export function companyScoped(companyIdColumn: PgColumn): SQL {
  return sql`${companyIdColumn}::text = current_setting('app.current_company_id', true)`;
}
