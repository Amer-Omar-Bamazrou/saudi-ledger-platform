/**
 * BATCH 1C — POLICY C: THE ONE PREDICATE THAT EXCLUDES A REVERSED OPENING ROW.
 *
 * Decision record: docs/product/batch-1c-migration-opening-balances-decision-pack.md
 * §16.12.1 (accountant A4, 2026-09-20). A migration's reversal never deletes
 * the opening invoices, bills and deposits it created — it MARKS them
 * (`reversed_at` + `reversed_by_migration_batch_id` on invoices/bills; a
 * superseding row in `migration_deposit_reversals` for a deposit) and the
 * mirror journal nets their GL effect to zero. So every reader that turns
 * those rows into a FIGURE — a receivable, a payable, a deposit position, an
 * ageing bucket, a statement balance, an overdue finding, a KPI total, a
 * matching candidate — must leave a marked row out, or the subledger says
 * one thing while the GL says another and nothing catches it.
 *
 * 🔴 ONE DEFINITION. Readers import these; none re-states the condition
 * (`tests/opening-reversal-reader-sweep.test.ts` fails when a repository that
 * reads invoice/bill/payment amounts does not import this module — written
 * red first, and it carries a planted positive so it is known to see).
 *
 * Two forms because the readers come in two dialects: the query-builder
 * predicates for Drizzle `where(...)` chains, and alias-parametrised raw SQL
 * fragments for the readers written as SQL strings.
 *
 * A reversed row is still READABLE by id (its detail carries `reversedAt`);
 * only figures and live lists exclude it. Lists exclude it so a reversed
 * opening invoice does not sit in the invoices list as "sent" with an
 * outstanding balance — a number shown that describes nothing.
 */
import { invoicesTable, billsTable, paymentsTable } from "@workspace/db";
import { isNull, sql, type SQL } from "drizzle-orm";

/** Drizzle form — an invoice that is not a reversed opening item. */
export const invoiceNotReversed = (): SQL => isNull(invoicesTable.reversedAt) as unknown as SQL;
/** Drizzle form — a bill that is not a reversed opening item. */
export const billNotReversed = (): SQL => isNull(billsTable.reversedAt) as unknown as SQL;
/** Drizzle form — a payment that is not a reversed opening deposit (no superseding reversal row). */
export const paymentNotReversed = (): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM migration_deposit_reversals mdr WHERE mdr.payment_id = ${paymentsTable.id})`;

/** Raw-SQL form, for a query that aliases `invoices` as `alias`. */
export const invoiceNotReversedSql = (alias: string): SQL => sql.raw(`${alias}.reversed_at IS NULL`);
/** Raw-SQL form, for a query that aliases `bills` as `alias`. */
export const billNotReversedSql = (alias: string): SQL => sql.raw(`${alias}.reversed_at IS NULL`);
/** Raw-SQL form, for a query that aliases `payments` as `alias`. */
export const paymentNotReversedSql = (alias: string): SQL =>
  sql.raw(`NOT EXISTS (SELECT 1 FROM migration_deposit_reversals mdr WHERE mdr.payment_id = ${alias}.id)`);

/** Plain-string forms for scripts that build SQL as text (ledgerInvariants.ts). */
export const INVOICE_NOT_REVERSED_TEXT = (alias: string) => `${alias}.reversed_at IS NULL`;
export const BILL_NOT_REVERSED_TEXT = (alias: string) => `${alias}.reversed_at IS NULL`;
export const PAYMENT_NOT_REVERSED_TEXT = (alias: string) => `NOT EXISTS (SELECT 1 FROM migration_deposit_reversals mdr WHERE mdr.payment_id = ${alias}.id)`;
