/**
 * PHASE 11 PART 2 — THE ONE DEFINITION OF WHAT A PURCHASE DOCUMENT OWES.
 *
 * Decision record: docs/product/phase-11-deep-accounting-ap-decision-pack.md
 * §12–§14 and §17.
 *
 * Before Part 2 a bill's outstanding was `total − paid_amount`, restated
 * locally by every reader. Part 2 changed BOTH halves of that expression:
 *
 *   · `bills.document_type` gained `credit_note`, a document that REDUCES
 *     what we owe — summed positively it inflates every total it enters;
 *   · money now reaches a bill through the AP subledger
 *     (`supplier_payment_allocations`: payments, applied advances, applied
 *     credit notes) as well as through the legacy `paid_amount` counter.
 *
 * A reader that kept the old expression was not "a little stale"; it offered
 * a settled bill for payment again, aged it as overdue, and put a credit note
 * into a supplier's spend. 🔴 ONE DEFINITION, imported by every reader —
 * `tests/bill-position-reader-sweep.test.ts` fails when a file that turns bill
 * rows into a figure does not import this module (it carries a planted
 * positive, so it is known to see).
 *
 * Two facts, each with ONE writer, are read together; neither is folded into
 * the other:
 *   · `bills.paid_amount`            — written only by `billsService.pay`;
 *   · live `supplier_payment_allocations` — written only by the AP subledger
 *     services, and "live" means no superseding reversal row.
 *
 * Three dialects, like `openingReversal.ts`, because the readers come in
 * three: alias-parametrised raw SQL (a Drizzle query over `billsTable` can
 * pass the alias "bills"), and plain text for `scripts/ledgerInvariants.ts`.
 * The subqueries use their own aliases (`bpos_a`, `bpos_r`) so they cannot
 * capture an outer alias.
 */
import { sql, type SQL } from "drizzle-orm";

const ident = (alias: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`billPosition: "${alias}" is not a SQL alias`);
  return alias;
};

/**
 * 🔴 Z-AP1 (2026-09-24): the SUPPLIER'S ADVANCE documents — `advance_invoice`
 * (their advance-payment tax invoice) and `advance_credit_note` (their note
 * against it) — carry VAT only. The advance was PAID before either existed, so
 * neither owes, bills or settles anything: sign 0, never payable, outstanding
 * 0, no AP contribution. Their only effects are input VAT (the VAT return reads
 * their lines) and the split of the advance asset (their own GL entries).
 */
const ADVANCE_DOCUMENT_TYPES_SQL = `('advance_invoice', 'advance_credit_note')`;

/** Plain-text forms — the source of truth; the SQL forms wrap these. */
export const BILL_SIGN_TEXT = (alias: string) =>
  `(CASE WHEN ${ident(alias)}.document_type = 'credit_note' THEN -1 WHEN ${alias}.document_type IN ${ADVANCE_DOCUMENT_TYPES_SQL} THEN 0 ELSE 1 END)`;

/** A document that can OWE something: a bill or a debit note. A credit note never can, nor can an advance document. */
export const BILL_IS_PAYABLE_TEXT = (alias: string) => `${ident(alias)}.document_type IN ('bill', 'debit_note')`;

/**
 * Σ live allocations TO this bill — payments, applied advances AND applied
 * credit notes. What the subledger has settled on the bill.
 */
export const BILL_LIVE_APPLIED_TEXT = (alias: string) =>
  `coalesce((SELECT sum(bpos_a.amount::numeric) FROM supplier_payment_allocations bpos_a
              WHERE bpos_a.bill_id = ${ident(alias)}.id
                AND NOT EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals bpos_r WHERE bpos_r.allocation_id = bpos_a.id)), 0)`;

/**
 * Σ live allocations to this bill that came from MONEY (a supplier payment or
 * an applied advance) — the part that moved AP in the GL. A credit-note
 * application moves no GL line (its debit is already in AP), so a reader that
 * ties to the GL uses this rather than the full applied figure.
 */
export const BILL_LIVE_PAID_BY_SUBLEDGER_TEXT = (alias: string) =>
  `coalesce((SELECT sum(bpos_a.amount::numeric) FROM supplier_payment_allocations bpos_a
              WHERE bpos_a.bill_id = ${ident(alias)}.id AND bpos_a.supplier_payment_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals bpos_r WHERE bpos_r.allocation_id = bpos_a.id)), 0)`;

/**
 * 🔴 WHAT THIS DOCUMENT STILL OWES. A credit note owes nothing (0); a bill or
 * a debit note owes its total less the legacy counter less the live
 * subledger allocations.
 */
export const BILL_OUTSTANDING_TEXT = (alias: string) =>
  `(CASE WHEN ${ident(alias)}.document_type NOT IN ('bill', 'debit_note') THEN 0::numeric
         ELSE ${alias}.total::numeric - coalesce(${alias}.paid_amount::numeric, 0) - ${BILL_LIVE_APPLIED_TEXT(alias)} END)`;

/**
 * 🔴 WHAT THIS DOCUMENT CONTRIBUTES TO AP IN THE GL (credit-positive): a bill
 * or debit note its total less what MONEY settled; a credit note minus its
 * total. Summed per supplier, this is the AP control balance for that
 * supplier — the subledger side of the GL tie.
 */
export const BILL_AP_CONTRIBUTION_TEXT = (alias: string) =>
  `(CASE WHEN ${ident(alias)}.document_type = 'credit_note' THEN -${alias}.total::numeric
         WHEN ${alias}.document_type IN ${ADVANCE_DOCUMENT_TYPES_SQL} THEN 0::numeric
         ELSE ${alias}.total::numeric - coalesce(${alias}.paid_amount::numeric, 0) - ${BILL_LIVE_PAID_BY_SUBLEDGER_TEXT(alias)} END)`;

/** SQL forms, for a query that aliases `bills` as `alias` (a Drizzle query over `billsTable` passes "bills"). */
export const billSignSql = (alias: string): SQL => sql.raw(BILL_SIGN_TEXT(alias));
export const billIsPayableSql = (alias: string): SQL => sql.raw(BILL_IS_PAYABLE_TEXT(alias));
export const billLiveAppliedSql = (alias: string): SQL => sql.raw(BILL_LIVE_APPLIED_TEXT(alias));
export const billLivePaidBySubledgerSql = (alias: string): SQL => sql.raw(BILL_LIVE_PAID_BY_SUBLEDGER_TEXT(alias));
export const billOutstandingSql = (alias: string): SQL => sql.raw(BILL_OUTSTANDING_TEXT(alias));
export const billApContributionSql = (alias: string): SQL => sql.raw(BILL_AP_CONTRIBUTION_TEXT(alias));
