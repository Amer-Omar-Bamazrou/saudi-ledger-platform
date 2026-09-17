/**
 * Phase E — a customer's POSITION and the event stream a statement is
 * rebuilt from. Every query runs inside the tenant transaction (RLS) and is
 * company-scoped in the query layer too (N1).
 *
 * 🔴 ONE DEFINITION OF WHAT A CUSTOMER'S POSITION IS. Three non-negative
 * components, each from its own subledger, and a NET that is DERIVED — never
 * a fourth stored figure:
 *
 *   receivable      = Σ over issued invoices / debit notes of
 *                     total − paid_amount − credited_amount            (≥ 0)
 *   creditBalance   = Σ issued credit-note totals − Σ ACTIVE applications
 *                     − Σ credit-note refunds                           (≥ 0)
 *   depositBalance  = Σ receipts − Σ ACTIVE receipt allocations
 *                     − Σ deposit refunds                               (≥ 0)
 *   netPosition     = receivable − creditBalance − depositBalance
 *                     (> 0: the customer owes us; < 0: we owe the customer)
 *
 * The three components map one-to-one onto the GL: AR(customer),
 * CUSTOMER_CREDITS(customer) and CUSTOMER_DEPOSITS(customer). A liability is
 * never expressed as a negative receivable (batch-1b decision pack §1.2).
 * `paymentsRepository.customerCreditPosition` was the Phase C reader of the
 * two liabilities; it now delegates here so the fact has one writer.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/** Drafts and submitted documents are not in the books (mirrors `INVOICE_NOT_IN_BOOKS`). */
const IN_BOOKS = sql`i.status NOT IN ('draft','submitted')`;
/** N1 — the scoped company's rows only, as raw SQL for the CTEs below (same predicate as `companyScoped`). */
const scopedCo = (alias: string) => sql.raw(`${alias}.company_id::text = current_setting('app.current_company_id', true)`);

export type CustomerPositionRow = {
  customerId: number;
  totalBilled: number;
  totalPaid: number;
  invoiceCount: number;
  receivable: number;
  creditBalance: number;
  depositBalance: number;
};

export type StatementEventKind = "invoice" | "debit_note" | "credit_note" | "receipt" | "allocation" | "credit_application" | "unallocation" | "refund";

export type StatementEventRow = {
  kind: StatementEventKind;
  date: string;
  ts: string;
  rank: number;
  id: number;
  documentNumber: string;
  reference: string | null;
  description: string;
  amount: number;
  receivableDelta: number;
  creditDelta: number;
  depositDelta: number;
  invoiceId: number | null;
  paymentId: number | null;
  creditNoteId: number | null;
  allocationId: number | null;
  refundId: number | null;
  journalEntryId: number | null;
};

export const customerStatementRepository = {
  /**
   * The position of one customer, or of every customer that has any
   * document, receipt or refund (one grouped query, never N+1). `restrictTo`
   * narrows the customer set (the list's filter) without changing the
   * arithmetic; it is a drizzle condition over `customersTable`, which is why
   * the outer query names the table rather than aliasing it.
   */
  async positions(opts: { customerId?: number; restrictTo?: SQL } = {}): Promise<CustomerPositionRow[]> {
    const custFilter = opts.customerId != null ? sql`AND customers.id = ${opts.customerId}` : sql``;
    const restrict = opts.restrictTo ? sql`AND (${opts.restrictTo})` : sql``;
    const rows = await db.execute<{
      customer_id: number; total_billed: string; total_paid: string; invoice_count: number;
      receivable: string; credit_balance: string; deposit_balance: string;
    }>(sql`
      WITH docs AS (
        SELECT i.customer_id,
               sum(CASE WHEN i.document_type = 'credit_note' THEN -1 ELSE 1 END * i.total::numeric) AS total_billed,
               sum(CASE WHEN i.document_type = 'credit_note' THEN 0 ELSE coalesce(i.paid_amount::numeric, 0) END) AS total_paid,
               count(*) AS invoice_count,
               sum(CASE WHEN i.document_type = 'credit_note' THEN 0
                        ELSE i.total::numeric - coalesce(i.paid_amount::numeric, 0) - coalesce(i.credited_amount::numeric, 0) END) AS receivable,
               sum(CASE WHEN i.document_type = 'credit_note' THEN i.total::numeric ELSE 0 END) AS notes_issued
          FROM invoices i
         WHERE ${IN_BOOKS} AND ${scopedCo("i")} AND i.customer_id IS NOT NULL
         GROUP BY i.customer_id),
      note_apps AS (
        SELECT n.customer_id, sum(a.amount::numeric) AS applied
          FROM payment_allocations a
          JOIN invoices n ON n.id = a.credit_note_id
          LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id
         WHERE a.credit_note_id IS NOT NULL AND r.id IS NULL AND ${scopedCo("n")}
         GROUP BY n.customer_id),
      receipts AS (
        SELECT p.customer_id, sum(p.amount::numeric) AS received
          FROM payments p
         WHERE p.direction = 'in' AND p.customer_id IS NOT NULL AND ${scopedCo("p")}
         GROUP BY p.customer_id),
      receipt_allocs AS (
        SELECT p.customer_id, sum(a.amount::numeric) AS allocated
          FROM payment_allocations a
          JOIN payments p ON p.id = a.payment_id
          LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id
         WHERE a.payment_id IS NOT NULL AND r.id IS NULL AND p.direction = 'in' AND ${scopedCo("p")}
         GROUP BY p.customer_id),
      refunds AS (
        SELECT f.customer_id,
               sum(CASE WHEN f.origin = 'deposit' THEN f.amount::numeric ELSE 0 END) AS deposit_refunded,
               sum(CASE WHEN f.origin = 'credit_note' THEN f.amount::numeric ELSE 0 END) AS credit_refunded
          FROM customer_refunds f
         WHERE ${scopedCo("f")}
         GROUP BY f.customer_id)
      SELECT customers.id AS customer_id,
             coalesce(d.total_billed, 0)::text AS total_billed,
             coalesce(d.total_paid, 0)::text AS total_paid,
             coalesce(d.invoice_count, 0)::int AS invoice_count,
             coalesce(d.receivable, 0)::text AS receivable,
             (coalesce(d.notes_issued, 0) - coalesce(na.applied, 0) - coalesce(rf.credit_refunded, 0))::text AS credit_balance,
             (coalesce(rc.received, 0) - coalesce(ra.allocated, 0) - coalesce(rf.deposit_refunded, 0))::text AS deposit_balance
        FROM customers
        LEFT JOIN docs d ON d.customer_id = customers.id
        LEFT JOIN note_apps na ON na.customer_id = customers.id
        LEFT JOIN receipts rc ON rc.customer_id = customers.id
        LEFT JOIN receipt_allocs ra ON ra.customer_id = customers.id
        LEFT JOIN refunds rf ON rf.customer_id = customers.id
       WHERE (d.customer_id IS NOT NULL OR rc.customer_id IS NOT NULL OR rf.customer_id IS NOT NULL) ${custFilter} ${restrict}
       ORDER BY customers.id`);
    return rows.rows.map((r) => ({
      customerId: r.customer_id,
      totalBilled: Number(r.total_billed),
      totalPaid: Number(r.total_paid),
      invoiceCount: Number(r.invoice_count),
      receivable: Number(r.receivable),
      creditBalance: Number(r.credit_balance),
      depositBalance: Number(r.deposit_balance),
    }));
  },

  /**
   * Every event that moved one of the three components for this customer, in
   * chronology: business date, then the timestamp the event was recorded,
   * then a kind rank for exact ties, then id. An allocation's business date
   * is the date of the journal it posted; an allocation made at receipt time
   * carries the receipt's date and timestamp, an application made at a
   * note's issue carries the note's. A back-dated event sorts by its business
   * date — the statement shows the books as dated, not as typed.
   */
  async events(customerId: number): Promise<StatementEventRow[]> {
    const rows = await db.execute<{
      kind: StatementEventKind; date: string; ts: string; rank: number; id: number; document_number: string; reference: string | null;
      description: string; amount: string; receivable_delta: string; credit_delta: string; deposit_delta: string;
      invoice_id: number | null; payment_id: number | null; credit_note_id: number | null; allocation_id: number | null; refund_id: number | null; journal_entry_id: number | null;
    }>(sql`
      SELECT * FROM (
        -- issued invoices and debit notes: the receivable rises by the total
        SELECT CASE WHEN i.document_type = 'debit_note' THEN 'debit_note' ELSE 'invoice' END AS kind,
               i.date::date::text AS date, coalesce(i.issued_at, i.created_at) AS ts, 0 AS rank, i.id,
               i.invoice_number AS document_number, NULL::text AS reference,
               CASE WHEN i.document_type = 'debit_note' THEN 'Debit note issued' ELSE 'Invoice issued' END AS description,
               i.total::numeric AS amount, i.total::numeric AS receivable_delta, 0::numeric AS credit_delta, 0::numeric AS deposit_delta,
               i.id AS invoice_id, NULL::int AS payment_id, NULL::int AS credit_note_id, NULL::int AS allocation_id, NULL::int AS refund_id, NULL::int AS journal_entry_id
          FROM invoices i
         WHERE i.customer_id = ${customerId} AND i.document_type <> 'credit_note' AND ${IN_BOOKS} AND ${scopedCo("i")}
        UNION ALL
        -- issued credit notes: the credit balance rises by the note; its application is its own line
        SELECT 'credit_note', i.date::date::text, coalesce(i.issued_at, i.created_at), 1, i.id,
               i.invoice_number, o.invoice_number,
               'Credit note issued' || CASE WHEN o.invoice_number IS NOT NULL THEN ' against ' || o.invoice_number ELSE '' END,
               i.total::numeric, 0, i.total::numeric, 0,
               NULL, NULL, i.id, NULL, NULL, NULL
          FROM invoices i
          LEFT JOIN invoices o ON o.id = i.original_invoice_id
         WHERE i.customer_id = ${customerId} AND i.document_type = 'credit_note' AND ${IN_BOOKS} AND ${scopedCo("i")}
        UNION ALL
        -- receipts: money in raises the deposit balance until it is allocated
        SELECT 'receipt', p.paid_at::text, p.created_at, 2, p.id,
               'RCPT-' || p.id::text, p.reference,
               'Payment received' || CASE WHEN p.method IS NOT NULL THEN ' (' || p.method || ')' ELSE '' END,
               p.amount::numeric, 0, 0, p.amount::numeric,
               NULL, p.id, NULL, NULL, NULL, p.journal_entry_id
          FROM payments p
         WHERE p.customer_id = ${customerId} AND p.direction = 'in' AND ${scopedCo("p")}
        UNION ALL
        -- a receipt allocated to an invoice: receivable and deposit both fall.
        -- Allocated AT receipt (no journal of its own) it carries the receipt's
        -- date and timestamp, so it follows its receipt exactly.
        SELECT 'allocation', coalesce(je.date::date, p.paid_at::date)::text, CASE WHEN a.journal_entry_id IS NULL THEN p.created_at ELSE a.created_at END, 4, a.id,
               i.invoice_number, 'RCPT-' || p.id::text,
               'Receipt RCPT-' || p.id::text || ' allocated to ' || i.invoice_number,
               a.amount::numeric, -a.amount::numeric, 0, -a.amount::numeric,
               i.id, p.id, NULL, a.id, NULL, a.journal_entry_id
          FROM payment_allocations a
          JOIN payments p ON p.id = a.payment_id
          JOIN invoices i ON i.id = a.invoice_id
          LEFT JOIN journal_entries je ON je.id = a.journal_entry_id
         WHERE p.customer_id = ${customerId} AND p.direction = 'in' AND ${scopedCo("p")}
        UNION ALL
        -- a credit note applied to an invoice: receivable and credit balance both fall.
        -- Applied AT issue (the note's own GL entry) it carries the note's
        -- timestamp, so it follows the note's issue line exactly.
        SELECT 'credit_application', coalesce(je.date::date, a.created_at::date)::text,
               CASE WHEN je.entry_number = 'GL-' || n.invoice_number THEN coalesce(n.issued_at, n.created_at) ELSE a.created_at END, 3, a.id,
               i.invoice_number, n.invoice_number,
               'Credit note ' || n.invoice_number || ' applied to ' || i.invoice_number,
               a.amount::numeric, -a.amount::numeric, -a.amount::numeric, 0,
               i.id, NULL, n.id, a.id, NULL, a.journal_entry_id
          FROM payment_allocations a
          JOIN invoices n ON n.id = a.credit_note_id
          JOIN invoices i ON i.id = a.invoice_id
          LEFT JOIN journal_entries je ON je.id = a.journal_entry_id
         WHERE n.customer_id = ${customerId} AND ${scopedCo("n")}
        UNION ALL
        -- an unallocation supersedes an allocation: its deltas come back
        SELECT 'unallocation', coalesce(je.date::date, r.created_at::date)::text, r.created_at, 5, r.id,
               i.invoice_number, coalesce('RCPT-' || a.payment_id::text, n.invoice_number),
               'Unallocated from ' || i.invoice_number || ': ' || r.reason,
               r.amount::numeric, r.amount::numeric,
               CASE WHEN a.credit_note_id IS NOT NULL THEN r.amount::numeric ELSE 0 END,
               CASE WHEN a.payment_id IS NOT NULL THEN r.amount::numeric ELSE 0 END,
               i.id, a.payment_id, a.credit_note_id, a.id, NULL, r.journal_entry_id
          FROM payment_allocation_reversals r
          JOIN payment_allocations a ON a.id = r.allocation_id
          JOIN invoices i ON i.id = a.invoice_id
          LEFT JOIN payments p ON p.id = a.payment_id
          LEFT JOIN invoices n ON n.id = a.credit_note_id
          LEFT JOIN journal_entries je ON je.id = r.journal_entry_id
         WHERE coalesce(p.customer_id, n.customer_id) = ${customerId} AND ${scopedCo("i")}
        UNION ALL
        -- a refund pays a liability out: deposit or credit balance falls
        SELECT 'refund', f.refunded_at::text, f.created_at, 6, f.id,
               'REFUND-' || f.id::text, coalesce(f.reference, CASE WHEN f.payment_id IS NOT NULL THEN 'RCPT-' || f.payment_id::text ELSE n.invoice_number END),
               CASE WHEN f.origin = 'deposit' THEN 'Deposit refunded' ELSE 'Credit note ' || coalesce(n.invoice_number, '') || ' refunded' END || ': ' || f.reason,
               f.amount::numeric, 0,
               CASE WHEN f.origin = 'credit_note' THEN -f.amount::numeric ELSE 0 END,
               CASE WHEN f.origin = 'deposit' THEN -f.amount::numeric ELSE 0 END,
               NULL, f.payment_id, f.credit_note_id, NULL, f.id, f.journal_entry_id
          FROM customer_refunds f
          LEFT JOIN invoices n ON n.id = f.credit_note_id
         WHERE f.customer_id = ${customerId} AND ${scopedCo("f")}
      ) e
      ORDER BY e.date::date, e.ts, e.rank, e.id`);
    return rows.rows.map((r) => ({
      kind: r.kind,
      date: String(r.date).slice(0, 10),
      ts: new Date(r.ts).toISOString(),
      rank: r.rank,
      id: r.id,
      documentNumber: r.document_number,
      reference: r.reference,
      description: r.description,
      amount: Number(r.amount),
      receivableDelta: Number(r.receivable_delta),
      creditDelta: Number(r.credit_delta),
      depositDelta: Number(r.deposit_delta),
      invoiceId: r.invoice_id,
      paymentId: r.payment_id,
      creditNoteId: r.credit_note_id,
      allocationId: r.allocation_id,
      refundId: r.refund_id,
      journalEntryId: r.journal_entry_id,
    }));
  },
};
