/**
 * B5 (Phase 11 Part 2, 2026-09-22) — a SUPPLIER'S POSITION and the event
 * stream a supplier statement is rebuilt from. Every query runs inside the
 * tenant transaction (RLS) and is company-scoped in the query layer too (N1).
 *
 * 🔴 ONE DEFINITION OF WHAT A SUPPLIER'S POSITION IS. Four non-negative
 * components, each from its own subledger, and a NET that is DERIVED — never
 * a fifth stored figure:
 *
 *   payable          = Σ over bills / debit notes of what each still owes
 *                      (billPosition: total − paid_amount − Σ live
 *                      allocations)                                       (≥ 0)
 *   creditBalance    = Σ approved credit-note totals − Σ live applications (≥ 0)
 *   advanceBalance   = Σ payments classified `advance` − their live
 *                      allocations − their refunds                        (≥ 0)
 *   depositBalance   = the same, for `security_deposit`                   (≥ 0)
 *   unidentified     = the same, for `erroneous` and `unknown`            (≥ 0)
 *   netPosition      = payable − creditBalance − advanceBalance
 *                      − depositBalance − unidentified
 *                      (> 0: we owe the supplier; < 0: they owe us)
 *
 * 🔴 HOW THESE MAP TO THE GL, INCLUDING THE ONE PLACE THEY DO NOT MAP ONE TO
 * ONE. `advanceBalance`, `depositBalance` and `unidentified` are exactly
 * SUPPLIER_ADVANCES, SECURITY_DEPOSITS_PAID and UNIDENTIFIED_PAYMENTS. But
 * `payable` and `creditBalance` BOTH live in AP(vendor): a purchase credit
 * note posts its debit straight into AP, so the GL carries their difference.
 * They are shown separately because "what we owe" and "what they owe us on a
 * note" are different facts to the person reading a statement, and the
 * reconciliation asserts payable − creditBalance against AP rather than
 * pretending to two accounts.
 *
 * 🔴 A LIABILITY IS NEVER EXPRESSED AS A NEGATIVE PAYABLE, and money the
 * supplier holds is never expressed as a negative one either — the same rule
 * the customer side carries, pointed the other way: a supplier advance is an
 * ASSET, not a reduction of what we owe.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { billNotReversedSql } from "./openingReversal";
import { billIsPayableSql, billLivePaidBySubledgerSql, billOutstandingSql, billSignSql } from "./billPosition";
import { supplierPaymentReversedSql } from "./paymentReversal";

/** Drafts and submitted documents are not in the books; a reversed opening item is history (Policy C). */
const IN_BOOKS = sql`b.status NOT IN ('draft','submitted') AND ${billNotReversedSql("b")}`;
/** N1 — the scoped company's rows only, as raw SQL for the CTEs below. */
const scopedCo = (alias: string) => sql.raw(`${alias}.company_id = nullif(current_setting('app.current_company_id', true), '')::uuid`);
/** An allocation that has not been superseded by a correction. */
const ALLOC_LIVE = sql`NOT EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals r WHERE r.allocation_id = a.id)`;

export type SupplierPositionRow = {
  vendorId: number;
  totalBilled: number;
  totalPaid: number;
  billCount: number;
  payable: number;
  creditBalance: number;
  advanceBalance: number;
  depositBalance: number;
  unidentifiedBalance: number;
};

export type SupplierStatementEventKind =
  | "bill" | "debit_note" | "credit_note"
  | "payment" | "bill_payment" | "allocation" | "credit_application" | "unallocation" | "refund" | "reclassification"
  // Q1 (pack §14.1): a WHT correction reversed the payment — the original stays, this answers it
  | "payment_reversal" | "bill_payment_reversal";

export type SupplierStatementEventRow = {
  kind: SupplierStatementEventKind;
  date: string;
  ts: string;
  rank: number;
  id: number;
  documentNumber: string;
  reference: string | null;
  description: string;
  amount: number;
  payableDelta: number;
  creditDelta: number;
  onAccountDelta: number;
  billId: number | null;
  paymentId: number | null;
  creditNoteId: number | null;
  allocationId: number | null;
  refundId: number | null;
  journalEntryId: number | null;
};

/**
 * Phase 14 (D14-08): one vendor (the statement) or EVERY vendor (as-of AP
 * ageing replays the same events up to a date). `null` = every vendor; the
 * SQL for a given id is unchanged.
 */
const vendorIs = (col: string, vendorId: number | null) => (vendorId == null ? sql`true` : sql`${sql.raw(col)} = ${vendorId}`);

export const supplierStatementRepository = {
  /**
   * Phase 17 (Treasury, pack §8.3) — every payable DOCUMENT still owed, one
   * row each, with its due date and its supplier's residency: THIS module's
   * in-books predicate and `billPosition`'s ONE definition of what a bill
   * owes. Σ outstanding = the AP ageing's total — pinned by a test.
   */
  async openPayables() {
    const { rows } = await db.execute<{
      id: number; bill_number: string | null; vendor_id: number | null; vendor_name: string | null; vendor_name_ar: string | null;
      vendor_residency: string | null; vendor_wht_default_payment_type: string | null; payment_terms_days: string | null;
      date: string; due_date: string | null; currency: string | null; outstanding: string;
    }>(sql`
      SELECT * FROM (
        SELECT b.id, b.bill_number, b.vendor_id, v.name AS vendor_name, v.name_ar AS vendor_name_ar, v.residency AS vendor_residency,
               v.wht_default_payment_type AS vendor_wht_default_payment_type, v.payment_terms_days,
               b.date::date::text AS date, nullif(b.due_date::text, '') AS due_date, b.currency,
               ${billOutstandingSql("b")}::text AS outstanding
          FROM bills b
          LEFT JOIN vendors v ON v.id = b.vendor_id
         WHERE ${IN_BOOKS} AND ${billIsPayableSql("b")} AND ${scopedCo("b")}
      ) x WHERE x.outstanding::numeric <> 0
      ORDER BY coalesce(x.due_date, x.date), x.id`);
    return rows;
  },

  /**
   * The position of one supplier, or of every supplier with any document,
   * payment or refund — one grouped query, never N+1.
   */
  async positions(opts: { vendorId?: number; restrictTo?: SQL } = {}): Promise<SupplierPositionRow[]> {
    const vendFilter = opts.vendorId != null ? sql`AND vendors.id = ${opts.vendorId}` : sql``;
    const restrict = opts.restrictTo ? sql`AND (${opts.restrictTo})` : sql``;
    const rows = await db.execute<{
      vendor_id: number; total_billed: string; total_paid: string; bill_count: number;
      payable: string; credit_balance: string; advance_balance: string; deposit_balance: string; unidentified_balance: string;
    }>(sql`
      WITH docs AS (
        -- Sign and outstanding from billPosition, the one definition.
        SELECT b.vendor_id,
               sum(${billSignSql("b")} * b.total::numeric) AS total_billed,
               sum(CASE WHEN ${billIsPayableSql("b")}
                        THEN coalesce(b.paid_amount::numeric, 0) + ${billLivePaidBySubledgerSql("b")} ELSE 0 END) AS total_paid,
               -- Z-AP1: the supplier's ADVANCE documents carry VAT only; they are
               -- not bills received, not notes received, and owe nothing.
               count(*) FILTER (WHERE b.document_type NOT IN ('advance_invoice', 'advance_credit_note')) AS bill_count,
               sum(greatest(${billOutstandingSql("b")}, 0)) AS payable,
               sum(CASE WHEN b.document_type = 'credit_note' THEN b.total::numeric ELSE 0 END) AS notes_received
          FROM bills b
         WHERE ${IN_BOOKS} AND ${scopedCo("b")} AND b.vendor_id IS NOT NULL
         GROUP BY b.vendor_id),
      note_apps AS (
        SELECT n.vendor_id, sum(a.amount::numeric) AS applied
          FROM supplier_payment_allocations a
          JOIN bills n ON n.id = a.supplier_credit_note_id
         WHERE a.supplier_credit_note_id IS NOT NULL AND ${ALLOC_LIVE} AND ${scopedCo("n")}
         GROUP BY n.vendor_id),
      on_account AS (
        SELECT p.vendor_id, p.classification,
               sum(p.amount::numeric
                   - coalesce((SELECT sum(a.amount::numeric) FROM supplier_payment_allocations a
                                WHERE a.supplier_payment_id = p.id AND ${ALLOC_LIVE}), 0)
                   - coalesce((SELECT sum(f.amount::numeric) FROM supplier_refunds f
                                WHERE f.supplier_payment_id = p.id), 0)
                   -- Q1: a payment a WHT correction reversed holds nothing on account (its mirror took it all back)
                   - CASE WHEN ${supplierPaymentReversedSql("p")} THEN p.amount::numeric ELSE 0 END) AS balance
          FROM supplier_payments p
         WHERE ${scopedCo("p")}
         GROUP BY p.vendor_id, p.classification)
      SELECT vendors.id AS vendor_id,
             coalesce(d.total_billed, 0)::text AS total_billed,
             coalesce(d.total_paid, 0)::text AS total_paid,
             coalesce(d.bill_count, 0)::int AS bill_count,
             coalesce(d.payable, 0)::text AS payable,
             greatest(coalesce(d.notes_received, 0) - coalesce(na.applied, 0), 0)::text AS credit_balance,
             coalesce((SELECT sum(o.balance) FROM on_account o WHERE o.vendor_id = vendors.id AND o.classification = 'advance'), 0)::text AS advance_balance,
             coalesce((SELECT sum(o.balance) FROM on_account o WHERE o.vendor_id = vendors.id AND o.classification = 'security_deposit'), 0)::text AS deposit_balance,
             coalesce((SELECT sum(o.balance) FROM on_account o WHERE o.vendor_id = vendors.id AND o.classification IN ('erroneous','unknown')), 0)::text AS unidentified_balance
        FROM vendors
        LEFT JOIN docs d ON d.vendor_id = vendors.id
        LEFT JOIN note_apps na ON na.vendor_id = vendors.id
       WHERE (d.vendor_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM supplier_payments p WHERE p.vendor_id = vendors.id AND ${scopedCo("p")}))
             ${vendFilter} ${restrict}
       ORDER BY vendors.id`);
    return rows.rows.map((r) => ({
      vendorId: r.vendor_id,
      totalBilled: Number(r.total_billed),
      totalPaid: Number(r.total_paid),
      billCount: Number(r.bill_count),
      payable: Number(r.payable),
      creditBalance: Number(r.credit_balance),
      advanceBalance: Number(r.advance_balance),
      depositBalance: Number(r.deposit_balance),
      unidentifiedBalance: Number(r.unidentified_balance),
    }));
  },

  /**
   * 🔴 THE GL SIDE OF THE TIE — what the ledger itself carries for this
   * supplier: the party-carrying lines on AP (credit-positive) and on each
   * on-account asset (debit-positive), in-books entries only (`posted` +
   * `reversed`: a reversed entry is IN the books beside its mirror). The
   * statement compares these to the subledger and REPORTS the comparison; a
   * control line with no party (pre-N3 history, RULE-P) cannot be attributed
   * and is therefore not here — which is a reason the comparison is reported
   * rather than asserted.
   */
  async glBalances(vendorId: number): Promise<{ ap: number; advances: number; deposits: number; unidentified: number }> {
    const { rows } = await db.execute<{ code: string; v: string }>(sql`
      SELECT c.system_code AS code, sum(l.debit_amount::numeric - l.credit_amount::numeric)::text AS v
        FROM journal_entry_lines l
        JOIN journal_entries e ON e.id = l.journal_entry_id
        JOIN categories c ON c.id = l.account_id
       WHERE l.vendor_id = ${vendorId}
         AND e.status IN ('posted', 'reversed')
         AND ${scopedCo("e")}
         AND c.system_code IN ('AP', 'SUPPLIER_ADVANCES', 'SECURITY_DEPOSITS_PAID', 'UNIDENTIFIED_PAYMENTS')
       GROUP BY c.system_code`);
    const by = new Map(rows.map((r) => [r.code, Number(r.v)]));
    return {
      ap: -(by.get("AP") ?? 0),
      advances: by.get("SUPPLIER_ADVANCES") ?? 0,
      deposits: by.get("SECURITY_DEPOSITS_PAID") ?? 0,
      unidentified: by.get("UNIDENTIFIED_PAYMENTS") ?? 0,
    };
  },

  /**
   * Every event that moved one of this supplier's components, in chronology:
   * business date, then the timestamp it was recorded, then a kind rank for
   * exact ties, then id. A back-dated event sorts by its BUSINESS date — the
   * statement shows the books as dated, not as typed.
   */
  async events(vendorId: number | null, opts: { upTo?: string } = {}): Promise<SupplierStatementEventRow[]> {
    const rows = await db.execute<{
      kind: SupplierStatementEventKind; date: string; ts: string; rank: number; id: number;
      document_number: string; reference: string | null; description: string; amount: string;
      payable_delta: string; credit_delta: string; on_account_delta: string;
      bill_id: number | null; payment_id: number | null; credit_note_id: number | null;
      allocation_id: number | null; refund_id: number | null; journal_entry_id: number | null;
    }>(sql`
      SELECT * FROM (
        -- bills and debit notes: the payable rises by the total
        SELECT CASE WHEN b.document_type = 'debit_note' THEN 'debit_note' ELSE 'bill' END AS kind,
               b.date::date::text AS date, b.created_at AS ts, 0 AS rank, b.id,
               b.bill_number AS document_number, b.vendor_reference AS reference,
               CASE WHEN b.document_type = 'debit_note' THEN 'Supplier debit note received' ELSE 'Bill received' END AS description,
               b.total::numeric AS amount, b.total::numeric AS payable_delta, 0::numeric AS credit_delta, 0::numeric AS on_account_delta,
               b.id AS bill_id, NULL::int AS payment_id, NULL::int AS credit_note_id, NULL::int AS allocation_id, NULL::int AS refund_id, NULL::int AS journal_entry_id
          FROM bills b
         WHERE ${vendorIs("b.vendor_id", vendorId)} AND b.document_type IN ('bill', 'debit_note') AND ${IN_BOOKS} AND ${scopedCo("b")}
        UNION ALL
        -- a credit note the supplier issued to us: their balance in our favour rises
        SELECT 'credit_note', b.date::date::text, b.created_at, 0, b.id,
               b.bill_number, o.bill_number,
               'Supplier credit note received against ' || coalesce(o.bill_number, 'a bill'),
               b.total::numeric, 0, b.total::numeric, 0,
               b.id, NULL, b.id, NULL, NULL, NULL
          FROM bills b
          LEFT JOIN bills o ON o.id = b.credit_note_against_bill_id
         WHERE ${vendorIs("b.vendor_id", vendorId)} AND b.document_type = 'credit_note' AND ${IN_BOOKS} AND ${scopedCo("b")}
        UNION ALL
        -- money we paid: what was not allocated AT THE TIME went on account. 🔴 Every allocation the payment's own entry
        -- made counts here, live or since superseded: the event is history, and a later reversal is its OWN event
        -- (an 'unallocation'), never a rewrite of this one (the customer statement's rule).
        SELECT 'payment', p.paid_at::date::text, p.created_at, 1, p.id,
               coalesce(p.reference, 'SPAY-' || p.id::text), p.reference,
               'Payment to the supplier (' || p.classification || ')',
               p.amount::numeric, 0, 0,
               p.amount::numeric - coalesce((SELECT sum(a.amount::numeric) FROM supplier_payment_allocations a
                                              WHERE a.supplier_payment_id = p.id AND a.journal_entry_id = p.journal_entry_id), 0),
               NULL, p.id, NULL, NULL, NULL, p.journal_entry_id
          FROM supplier_payments p
         WHERE ${vendorIs("p.vendor_id", vendorId)} AND ${scopedCo("p")}
        UNION ALL
        /*
         * 🔴 THE LEGACY PER-BILL PAY PATH. billsService.pay writes
         * bills.paid_amount and a bill_payments row, and that is a SECOND,
         * older writer of "what this bill still owes" — the position query
         * subtracts it, so the event stream has to show it too or the two
         * computations disagree by exactly the amount paid that way.
         *
         * 🔴 Found by the statement's OWN reconciliation, on real seeded
         * rows, which is the entire reason that check is REPORTED rather than
         * assumed. (A backtick cannot appear in this comment: it sits inside a
         * SQL template literal, and one would end the string.) The two writers
         * stay separate; every derived figure reads both.
         */
        SELECT 'bill_payment', bp.paid_at::date::text, bp.created_at, 1, bp.id,
               tb.bill_number, NULL, 'Paid against ' || tb.bill_number,
               bp.amount::numeric, -bp.amount::numeric, 0, 0,
               bp.bill_id, NULL, NULL, NULL, NULL, NULL
          FROM bill_payments bp
          JOIN bills tb ON tb.id = bp.bill_id
         WHERE ${vendorIs("tb.vendor_id", vendorId)} AND ${scopedCo("bp")}
        UNION ALL
        -- an allocation: the payable falls. From a PAYMENT it also consumes on-account money.
        -- 🔴 Listed whether or not it was later superseded: its 'unallocation' (below) brings the deltas back. Filtering
        -- superseded allocations out AND adding their unallocations counted every reversal twice — payable and
        -- on-account each overstated by the amount, the net unchanged, so the net-only self-check stayed green and the
        -- as-of AP ageing aged the bill at more than it owed (found 2026-10-05, probing Q1 on real rows).
        SELECT CASE WHEN a.supplier_credit_note_id IS NOT NULL THEN 'credit_application' ELSE 'allocation' END,
               coalesce(e.date::date::text, (a.created_at AT TIME ZONE 'Asia/Riyadh')::date::text), a.created_at, 2, a.id,
               tb.bill_number, NULL,
               CASE WHEN a.supplier_credit_note_id IS NOT NULL
                    THEN 'Credit note applied to ' || tb.bill_number
                    ELSE 'Payment applied to ' || tb.bill_number END,
               a.amount::numeric, -a.amount::numeric,
               CASE WHEN a.supplier_credit_note_id IS NOT NULL THEN -a.amount::numeric ELSE 0 END,
               CASE WHEN a.supplier_payment_id IS NOT NULL AND a.journal_entry_id IS DISTINCT FROM p.journal_entry_id
                    THEN -a.amount::numeric ELSE 0 END,
               a.bill_id, a.supplier_payment_id, a.supplier_credit_note_id, a.id, NULL, a.journal_entry_id
          FROM supplier_payment_allocations a
          JOIN bills tb ON tb.id = a.bill_id
          LEFT JOIN supplier_payments p ON p.id = a.supplier_payment_id
          LEFT JOIN journal_entries e ON e.id = a.journal_entry_id
         WHERE ${vendorIs("tb.vendor_id", vendorId)} AND ${scopedCo("a")}
        UNION ALL
        -- a correction: the original allocation row stays; this is the record that answers it
        SELECT 'unallocation', coalesce(e.date::date::text, (rv.created_at AT TIME ZONE 'Asia/Riyadh')::date::text), rv.created_at, 3, rv.id,
               tb.bill_number, NULL, 'Allocation reversed: ' || rv.reason,
               a.amount::numeric, a.amount::numeric,
               CASE WHEN a.supplier_credit_note_id IS NOT NULL THEN a.amount::numeric ELSE 0 END,
               CASE WHEN a.supplier_payment_id IS NOT NULL THEN a.amount::numeric ELSE 0 END,
               a.bill_id, a.supplier_payment_id, a.supplier_credit_note_id, a.id, NULL, rv.journal_entry_id
          FROM supplier_payment_allocation_reversals rv
          JOIN supplier_payment_allocations a ON a.id = rv.allocation_id
          JOIN bills tb ON tb.id = a.bill_id
          LEFT JOIN journal_entries e ON e.id = rv.journal_entry_id
         WHERE ${vendorIs("tb.vendor_id", vendorId)} AND ${scopedCo("rv")}
        UNION ALL
        -- the supplier returns money: what they held falls
        SELECT 'refund', f.refunded_at::date::text, f.created_at, 4, f.id,
               'SREFUND-' || f.id::text, NULL, 'Refund from the supplier: ' || f.reason,
               f.amount::numeric, 0, 0, -f.amount::numeric,
               NULL, f.supplier_payment_id, NULL, NULL, f.id, f.journal_entry_id
          FROM supplier_refunds f
         WHERE ${vendorIs("f.vendor_id", vendorId)} AND ${scopedCo("f")}
        UNION ALL
        -- Q1 (pack §14.1): a WHT correction reversed a bill payment — the bill owes it again; the payment row stays
        SELECT 'bill_payment_reversal', c.corrected_on::date::text, c.created_at, 6, c.id,
               tb.bill_number, NULL, 'Payment against ' || tb.bill_number || ' reversed (WHT correction): ' || c.reason,
               bp.amount::numeric, bp.amount::numeric, 0, 0,
               bp.bill_id, NULL, NULL, NULL, NULL, c.reversal_journal_entry_id
          FROM wht_corrections c
          JOIN bill_payments bp ON bp.id = c.bill_payment_id
          JOIN bills tb ON tb.id = bp.bill_id
         WHERE ${vendorIs("tb.vendor_id", vendorId)} AND ${scopedCo("c")}
        UNION ALL
        -- Q1: a WHT correction reversed a supplier payment — after its allocations' unallocations, the whole payment leaves on-account
        SELECT 'payment_reversal', c.corrected_on::date::text, c.created_at, 6, c.id,
               coalesce(p.reference, 'SPAY-' || p.id::text), p.reference, 'Payment reversed (WHT correction): ' || c.reason,
               p.amount::numeric, 0, 0, -p.amount::numeric,
               NULL, p.id, NULL, NULL, NULL, c.reversal_journal_entry_id
          FROM wht_corrections c
          JOIN supplier_payments p ON p.id = c.supplier_payment_id
         WHERE ${vendorIs("p.vendor_id", vendorId)} AND ${scopedCo("c")}
        UNION ALL
        -- saying what money on account IS: nothing moves between the components, but the chronology has to show the act
        SELECT 'reclassification', coalesce(c.effective_date::date::text, (c.created_at AT TIME ZONE 'Asia/Riyadh')::date::text), c.created_at, 5, c.id,
               coalesce(p.reference, 'SPAY-' || p.id::text), NULL,
               'Reclassified as ' || c.classification || coalesce(' — ' || c.note, ''),
               0::numeric, 0, 0, 0,
               NULL, p.id, NULL, NULL, NULL, c.journal_entry_id
          FROM supplier_payment_classifications c
          JOIN supplier_payments p ON p.id = c.supplier_payment_id
         WHERE ${vendorIs("p.vendor_id", vendorId)} AND ${scopedCo("c")}
      ) ev
      ${opts.upTo ? sql`WHERE ev.date::date <= ${opts.upTo}::date` : sql``}
      ORDER BY ev.date, ev.ts, ev.rank, ev.id`);
    return rows.rows.map((r) => ({
      kind: r.kind, date: r.date, ts: new Date(r.ts).toISOString(), rank: Number(r.rank), id: r.id,
      documentNumber: r.document_number, reference: r.reference, description: r.description,
      amount: Number(r.amount),
      payableDelta: Number(r.payable_delta),
      creditDelta: Number(r.credit_delta),
      onAccountDelta: Number(r.on_account_delta),
      billId: r.bill_id, paymentId: r.payment_id, creditNoteId: r.credit_note_id,
      allocationId: r.allocation_id, refundId: r.refund_id, journalEntryId: r.journal_entry_id,
    }));
  },
};
