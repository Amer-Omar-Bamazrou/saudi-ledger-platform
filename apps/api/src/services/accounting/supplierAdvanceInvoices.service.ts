/**
 * Z-AP1 — THE SUPPLIER'S ADVANCE TAX INVOICE, AND THE FINAL BILL THAT DEDUCTS IT
 * (2026-09-24). Accountant answer: **A**.
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §8.
 *
 * When we pay a supplier in advance, the SUPPLIER's tax point is the receipt
 * of our money (GCC Agreement Art. 23(1)), so a VAT-registered supplier issues
 * us a tax invoice for the advance (IR Art. 53(1)(a)(2) — their type 386).
 * Holding it is the evidence IR Art. 49(7) asks for, so its input VAT is
 * claimed in ITS period (the accountant's decision; IR Art. 49(8) would also
 * allow a later period — the decision takes the earliest). The supplier's
 * final invoice shows the FULL supply and deducts the prepayment (KSA-31/32),
 * so the final bill here claims only what the advance invoice did not.
 *
 *   advance paid 11,500            Dr Supplier advances 11,500 / Cr Bank        (Phase 11, unchanged)
 *   advance invoice 10,000 + 1,500 Dr Input VAT 1,500 / Cr Supplier advances 1,500   ← claimed HERE
 *   final bill 30,000 + 4,500      Dr Expense 30,000 · Dr Input VAT 3,000
 *     applying the 11,500 advance      / Cr AP 23,000 · Cr Supplier advances 10,000
 *
 * 🔴 THE SAME INPUT VAT IS NEVER CLAIMED TWICE: the final bill's VAT line and
 * the VAT return both take the adjusted advance's tax OUT of the final bill
 * (the return reads its lines in full and deducts its `bill_prepayments`
 * rows), so over the two periods 4,500 is claimed exactly once.
 *
 * A refund or cancellation of an invoiced advance is corrected by the
 * SUPPLIER's credit note against their advance invoice (`advance_credit_note`),
 * which reverses the VAT in the note's own period (IR Art. 40(6)) — never by
 * netting, never by editing the advance invoice.
 *
 * These documents are the SUPPLIER's, which we RECEIVE (like B7's notes): no
 * ICV, no QR, no hash chain, nothing to the outbox. They are `bills` rows,
 * approved through the one bill approval path.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, billsTable, billItemsTable, billPrepaymentsTable, supplierPaymentAllocationsTable, vendorsTable, type SupplierPayment } from "@workspace/db";
import { DEFAULT_VAT_RATE, businessToday } from "@workspace/shared";
import { BusinessRuleError, NotFoundError } from "../../lib/errors.js";
import { round2, money2 } from "../../lib/money.js";
import { auditService } from "../audit.service.js";
import { postJournalEntry } from "./glPosting.js";
import { checkPeriodOpen } from "./periodLock.js";
import { documentNumbersRepository } from "../../repositories/documentNumbers.repository.js";
import { SUPPLIER_ON_ACCOUNT_ASSET_NAME } from "./supplierCreditPolicy.js";

const refuse = (code: string, error: string, field?: string, status = 422, extra: Record<string, unknown> = {}): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}), ...extra });
};
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The rates a supplier advance invoice may carry: standard, or zero (zero-rated / exempt advance). */
const ALLOWED_RATES = [DEFAULT_VAT_RATE, 0];

/**
 * Split a VAT-inclusive amount at a rate, to the halala, so that
 * taxable + vat = amount and vat = taxable × rate within a halala (the same
 * rule the supplier's KSA-31/32 must satisfy).
 */
export function splitInclusive(amount: number, ratePercent: number): { taxable: number; vat: number } {
  const gross = round2(amount);
  const taxable = round2(gross / (1 + ratePercent / 100));
  return { taxable, vat: round2(gross - taxable) };
}

export type AdvanceInvoiceOpen = {
  id: number; billNumber: string; vendorReference: string | null; date: string; supplierPaymentId: number;
  vatRate: number; total: number; taxable: number; tax: number;
  credited: number; adjusted: number; open: number; openTaxable: number; openTax: number;
};

/** Every APPROVED advance invoice (of one payment, or one supplier), with what is still open on it. */
async function advanceInvoicesOpen(filter: { supplierPaymentId?: number; vendorId?: number; ids?: number[] }): Promise<AdvanceInvoiceOpen[]> {
  const { rows } = await db.execute<{
    id: number; bill_number: string; vendor_reference: string | null; date: string; payment_id: number; vat_rate: string;
    total: string; taxable: string; tax: string;
    cr_total: string; cr_taxable: string; cr_tax: string; adj_total: string; adj_taxable: string; adj_tax: string;
  }>(sql`
    SELECT b.id, b.bill_number, b.vendor_reference, b.date, b.advance_supplier_payment_id AS payment_id,
           coalesce((SELECT i.vat_rate FROM bill_items i WHERE i.bill_id = b.id ORDER BY i.id LIMIT 1), 0)::text AS vat_rate,
           b.total::text, b.subtotal::text AS taxable, b.vat_amount::text AS tax,
           coalesce(cr.total, 0)::text AS cr_total, coalesce(cr.taxable, 0)::text AS cr_taxable, coalesce(cr.tax, 0)::text AS cr_tax,
           coalesce(adj.total, 0)::text AS adj_total, coalesce(adj.taxable, 0)::text AS adj_taxable, coalesce(adj.tax, 0)::text AS adj_tax
      FROM bills b
      LEFT JOIN LATERAL (
        SELECT sum(n.total) AS total, sum(n.subtotal) AS taxable, sum(n.vat_amount) AS tax FROM bills n
         WHERE n.credit_note_against_bill_id = b.id AND n.document_type = 'advance_credit_note'
           AND n.status NOT IN ('draft', 'submitted')) cr ON true
      LEFT JOIN LATERAL (
        SELECT sum(p.amount) AS total, sum(p.taxable_amount) AS taxable, sum(p.tax_amount) AS tax FROM bill_prepayments p
         WHERE p.advance_bill_id = b.id AND p.allocation_id IS NOT NULL) adj ON true
     WHERE b.document_type = 'advance_invoice' AND b.status NOT IN ('draft', 'submitted')
       ${filter.supplierPaymentId != null ? sql`AND b.advance_supplier_payment_id = ${filter.supplierPaymentId}` : sql``}
       ${filter.vendorId != null ? sql`AND b.vendor_id = ${filter.vendorId}` : sql``}
       ${filter.ids?.length ? sql`AND b.id IN (${sql.join(filter.ids.map((i) => sql`${i}`), sql`, `)})` : sql``}
     ORDER BY b.date, b.id`);
  return rows.map((r) => {
    const total = Number(r.total), taxable = Number(r.taxable), tax = Number(r.tax);
    const credited = Number(r.cr_total), adjusted = Number(r.adj_total);
    return {
      id: Number(r.id), billNumber: r.bill_number, vendorReference: r.vendor_reference, date: r.date,
      supplierPaymentId: Number(r.payment_id), vatRate: Number(r.vat_rate),
      total, taxable, tax, credited, adjusted,
      open: round2(total - credited - adjusted),
      openTaxable: round2(taxable - Number(r.cr_taxable) - Number(r.adj_taxable)),
      openTax: round2(tax - Number(r.cr_tax) - Number(r.adj_tax)),
    };
  });
}

/** Lock a supplier payment row (the same lock every act that spends its money takes). */
async function lockPayment(id: number): Promise<SupplierPayment> {
  const { supplierPaymentsService } = await import("./supplierPayments.service.js");
  return supplierPaymentsService.findOrThrow(id, { lock: true });
}

export type PrepaymentInput = { advanceBillId: number; amount?: number | null; taxAmount?: number | null };
export type FinalBillCheck = { prepared: PreparedPrepayment[]; amount: number; taxable: number; tax: number };
export type PreparedPrepayment = { advanceBillId: number; supplierPaymentId: number; amount: number; taxableAmount: number; taxAmount: number; vatRate: number; advanceBillNumber: string };

export const supplierAdvanceInvoicesService = {
  /**
   * What an advance payment's money is, split by what the supplier has
   * invoiced: `invoiced` (approved advance invoices), `credited` (their
   * credit notes), `adjusted` (deducted by final bills), `open` (invoiced,
   * not yet deducted or credited — its VAT is claimed and sits in Input VAT),
   * and `uninvoiced` (still on account with no invoice — the only part a
   * plain allocation or a refund may spend).
   */
  async figures(payment: { id: number }, available: number) {
    const invoices = await advanceInvoicesOpen({ supplierPaymentId: payment.id });
    const sum = (f: (i: AdvanceInvoiceOpen) => number) => round2(invoices.reduce((s, i) => s + f(i), 0));
    const open = sum((i) => i.open);
    return {
      advanceInvoicedAmount: sum((i) => i.total),
      advanceCreditedAmount: sum((i) => i.credited),
      advanceAdjustedAmount: sum((i) => i.adjusted),
      advanceOpenAmount: open,
      advanceOpenVat: sum((i) => i.openTax),
      uninvoicedAmount: round2(Math.max(0, available - open)),
      advanceInvoices: invoices,
    };
  },

  /** The open advance invoices of one supplier — the picker a final bill chooses from. */
  openForVendor(vendorId: number) {
    return advanceInvoicesOpen({ vendorId }).then((rows) => rows.filter((r) => r.open > 0.005));
  },

  /**
   * Record the supplier's advance tax invoice as a DRAFT `advance_invoice`
   * bill against an ADVANCE payment. `amount` is VAT-inclusive (what the
   * supplier's invoice totals) and may not exceed what is still un-invoiced.
   * Nothing posts until the draft is approved.
   */
  async createFromPayment(paymentId: number, body: Record<string, unknown>, userId: number | null) {
    const { supplierPaymentsService } = await import("./supplierPayments.service.js");
    const payment = await lockPayment(paymentId);
    if (payment.classification !== "advance") {
      refuse("advance_invoice_requires_advance", "Only a payment classified as an ADVANCE can be invoiced by the supplier: a deposit, an erroneous or an unidentified payment is not consideration for a supply. Reclassify it first if that is what it has become.", "classification", 409);
    }
    const amount = round2(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) refuse("amount_invalid", "The supplier's advance invoice totals a positive amount.", "amount");
    const rate = body.vatRate == null || body.vatRate === "" ? DEFAULT_VAT_RATE : Number(body.vatRate);
    if (!ALLOWED_RATES.includes(rate)) refuse("vat_rate_invalid", `An advance invoice carries VAT at ${DEFAULT_VAT_RATE}% or 0%.`, "vatRate");
    const date = isDate(body.date) ? body.date : businessToday();
    if (date < payment.paidAt) refuse("date_before_payment", `The advance was paid on ${payment.paidAt}; the supplier cannot have invoiced it earlier.`, "date");
    // 🔴 The claim lands in the invoice's period, so that period must be OPEN.
    await checkPeriodOpen(date);
    const f = await this.figures(payment, await supplierPaymentsService.availableOf(paymentId));
    if (amount > f.uninvoicedAmount + 0.005) {
      refuse("advance_invoice_exceeds_uninvoiced", `Only ${f.uninvoicedAmount.toFixed(2)} of this advance is not yet invoiced by the supplier; ${amount.toFixed(2)} was entered.`, "amount", 409);
    }
    const split = splitInclusive(amount, rate);
    const vendorReference = text(body.vendorReference);
    if (!vendorReference) refuse("vendor_reference_required", "Enter the supplier's invoice number — it is the evidence the input VAT claim rests on (IR Art. 49(7)).", "vendorReference");
    const billNumber = text(body.billNumber) ?? await documentNumbersRepository.allocate("bill");
    const [bill] = await db.insert(billsTable).values({
      billNumber, vendorReference, date, vendorId: payment.vendorId, documentType: "advance_invoice",
      advanceSupplierPaymentId: paymentId, status: "draft",
      subtotal: money2(split.taxable), vatAmount: money2(split.vat), total: money2(amount),
      notes: text(body.notes), createdBy: userId,
    }).returning();
    await db.insert(billItemsTable).values({
      billId: bill!.id, description: `Advance payment — supplier invoice ${vendorReference}`,
      quantity: "1", unitPrice: money2(split.taxable), vatRate: String(rate), vatAmount: money2(split.vat), total: money2(amount),
    });
    await auditService.record({ action: "create", entityType: "bill", entityId: String(bill!.id), before: null, after: { documentType: "advance_invoice", supplierPaymentId: paymentId, amount, taxable: split.taxable, vat: split.vat, date } });
    return bill!;
  },

  /**
   * Record the supplier's credit note against their advance invoice (the
   * advance refunded or cancelled) as a DRAFT `advance_credit_note`. Capped at
   * what is still open on that invoice. Its approval reverses the VAT in the
   * note's own period (IR Art. 40(6)); nothing touches AP.
   */
  async createCreditNote(advanceBillId: number, body: Record<string, unknown>, userId: number | null) {
    const [inv] = await advanceInvoicesOpen({ ids: [advanceBillId] });
    if (!inv) refuse("advance_invoice_unknown", "That is not an approved supplier advance tax invoice.", "advanceBillId", 404);
    await lockPayment(inv!.supplierPaymentId);
    const amount = round2(Number(body.amount ?? inv!.open));
    if (!Number.isFinite(amount) || amount <= 0) refuse("amount_invalid", "A credit note credits a positive amount.", "amount");
    if (amount > inv!.open + 0.005) refuse("credit_exceeds_open_advance_invoice", `${inv!.billNumber} has ${inv!.open.toFixed(2)} still open (not deducted by a final bill or already credited); ${amount.toFixed(2)} was entered.`, "amount", 409);
    const date = isDate(body.date) ? body.date : businessToday();
    if (date < inv!.date) refuse("date_before_advance_invoice", `The advance invoice is dated ${inv!.date}; a note against it cannot be earlier.`, "date");
    await checkPeriodOpen(date);
    const split = Math.abs(amount - inv!.open) < 0.005 ? { taxable: inv!.openTaxable, vat: inv!.openTax } : splitInclusive(amount, inv!.vatRate);
    if (split.vat > inv!.openTax + 0.005 || split.taxable > inv!.openTaxable + 0.005) refuse("credit_exceeds_open_advance_invoice", "The note's split exceeds what is open on the advance invoice.", "amount", 409);
    const vendorReference = text(body.vendorReference);
    if (!vendorReference) refuse("vendor_reference_required", "Enter the supplier's credit note number.", "vendorReference");
    const [orig] = await db.select().from(billsTable).where(eq(billsTable.id, advanceBillId)).limit(1);
    const billNumber = text(body.billNumber) ?? await documentNumbersRepository.allocate("bill");
    const [note] = await db.insert(billsTable).values({
      billNumber, vendorReference, date, vendorId: orig!.vendorId, documentType: "advance_credit_note",
      creditNoteAgainstBillId: advanceBillId, status: "draft",
      subtotal: money2(split.taxable), vatAmount: money2(split.vat), total: money2(amount),
      notes: text(body.notes), createdBy: userId,
    }).returning();
    await db.insert(billItemsTable).values({
      billId: note!.id, description: `Credit against advance invoice ${inv!.billNumber}`,
      quantity: "1", unitPrice: money2(split.taxable), vatRate: String(inv!.vatRate), vatAmount: money2(split.vat), total: money2(amount),
    });
    await auditService.record({ action: "create", entityType: "bill", entityId: String(note!.id), before: null, after: { documentType: "advance_credit_note", against: advanceBillId, amount, date } });
    return note!;
  },

  /**
   * Check a final bill's prepayment selection against the supplier's open
   * advance invoices and the bill's own totals. Each row's split is the
   * supplier's KSA-31/32: a full deduction copies what is open exactly; a
   * partial one takes the supplier's stated `taxAmount` (checked to the halala
   * against the rate) or splits at the invoice's rate.
   */
  async preparePrepayments(requested: PrepaymentInput[], bill: { vendorId: number | null; date: string; subtotal: number; vatAmount: number; total: number; documentType: string; capitalisesAssetId?: number | null }): Promise<PreparedPrepayment[]> {
    if (requested.length === 0) return [];
    if (bill.documentType !== "bill") refuse("prepayment_only_on_bill", "Only a bill (the supplier's final invoice) deducts an advance.", "prepayments");
    if (bill.capitalisesAssetId != null) refuse("prepayment_on_capitalised_bill", "A bill that capitalises a fixed asset cannot deduct an advance yet — record the asset's cost without the advance, or deduct the advance on a separate bill.", "prepayments");
    if (bill.vendorId == null) refuse("prepayment_requires_vendor", "Name the supplier before deducting their advance.", "vendorId");
    const ids = requested.map((r) => Number(r.advanceBillId));
    if (ids.some((i) => !Number.isInteger(i) || i <= 0)) refuse("advance_invoice_unknown", "Each prepayment names a supplier advance invoice.", "prepayments");
    if (new Set(ids).size !== ids.length) refuse("prepayment_duplicate", "An advance invoice is named more than once — state one amount per invoice.", "prepayments");
    const open = new Map((await advanceInvoicesOpen({ ids })).map((i) => [i.id, i]));
    const out: PreparedPrepayment[] = [];
    for (const r of requested) {
      const inv = open.get(Number(r.advanceBillId));
      if (!inv) refuse("advance_invoice_unknown", `Bill ${r.advanceBillId} is not an approved supplier advance tax invoice.`, "prepayments");
      const [row] = await db.select({ vendorId: billsTable.vendorId }).from(billsTable).where(eq(billsTable.id, inv!.id)).limit(1);
      if (row!.vendorId !== bill.vendorId) refuse("prepayment_other_vendor", `${inv!.billNumber} is another supplier's advance invoice.`, "prepayments");
      if (bill.date < inv!.date) refuse("prepayment_before_advance_invoice", `${inv!.billNumber} is dated ${inv!.date}; a bill dated ${bill.date} cannot deduct it.`, "prepayments");
      const amount = r.amount == null ? inv!.open : round2(Number(r.amount));
      if (!Number.isFinite(amount) || amount <= 0) refuse("prepayment_amount_invalid", "Each prepayment deducts a positive amount.", "prepayments");
      if (amount > inv!.open + 0.005) refuse("prepayment_exceeds_open", `${inv!.billNumber} has ${inv!.open.toFixed(2)} open; ${amount.toFixed(2)} was deducted.`, "prepayments", 409);
      let taxable: number, tax: number;
      if (Math.abs(amount - inv!.open) < 0.005 && r.taxAmount == null) {
        taxable = inv!.openTaxable; tax = inv!.openTax;
      } else if (r.taxAmount != null) {
        tax = round2(Number(r.taxAmount));
        taxable = round2(amount - tax);
        const expected = round2(taxable * inv!.vatRate / 100);
        if (!Number.isFinite(tax) || tax < 0 || taxable < 0 || Math.abs(tax - expected) > 0.01 + 1e-9) {
          refuse("prepayment_tax_does_not_split", `A deduction of ${amount.toFixed(2)} with VAT ${tax.toFixed(2)} does not split at ${inv!.vatRate}% (taxable ${taxable.toFixed(2)} × ${inv!.vatRate}% = ${expected.toFixed(2)}).`, "prepayments");
        }
      } else {
        ({ taxable, vat: tax } = splitInclusive(amount, inv!.vatRate));
      }
      if (tax > inv!.openTax + 0.005 || taxable > inv!.openTaxable + 0.005) refuse("prepayment_exceeds_open", `The deduction's split exceeds what is open on ${inv!.billNumber}.`, "prepayments", 409);
      out.push({ advanceBillId: inv!.id, supplierPaymentId: inv!.supplierPaymentId, amount, taxableAmount: taxable, taxAmount: tax, vatRate: inv!.vatRate, advanceBillNumber: inv!.billNumber });
    }
    const sum = (f: (p: PreparedPrepayment) => number) => round2(out.reduce((s, p) => s + f(p), 0));
    if (sum((p) => p.amount) > bill.total + 0.005) refuse("prepayment_exceeds_bill", `The advances deducted (${sum((p) => p.amount).toFixed(2)}) exceed the bill's total (${bill.total.toFixed(2)}).`, "prepayments", 409);
    if (sum((p) => p.taxAmount) > bill.vatAmount + 0.005 || sum((p) => p.taxableAmount) > bill.subtotal + 0.005) {
      refuse("prepayment_exceeds_bill", "The advances deducted carry more VAT or taxable value than the bill itself — the final invoice cannot deduct more than it charges.", "prepayments", 409);
    }
    return out;
  },

  /** Replace a DRAFT bill's prepayment rows (the trigger refuses once it is approved). */
  async writePrepayments(billId: number, rows: PreparedPrepayment[]) {
    await db.delete(billPrepaymentsTable).where(eq(billPrepaymentsTable.billId, billId));
    for (const p of rows) {
      await db.insert(billPrepaymentsTable).values({
        billId, advanceBillId: p.advanceBillId, amount: money2(p.amount),
        taxableAmount: money2(p.taxableAmount), taxAmount: money2(p.taxAmount), vatRate: String(p.vatRate),
      });
    }
  },

  async prepaymentsOf(billId: number) {
    const { rows } = await db.execute<{ id: number; advance_bill_id: number; bill_number: string; vendor_reference: string | null; amount: string; taxable_amount: string; tax_amount: string; vat_rate: string; allocation_id: number | null }>(sql`
      SELECT p.id, p.advance_bill_id, a.bill_number, a.vendor_reference, p.amount::text, p.taxable_amount::text, p.tax_amount::text, p.vat_rate::text, p.allocation_id
        FROM bill_prepayments p JOIN bills a ON a.id = p.advance_bill_id WHERE p.bill_id = ${billId} ORDER BY p.id`);
    return rows.map((r) => ({
      id: Number(r.id), advanceBillId: Number(r.advance_bill_id), advanceBillNumber: r.bill_number, supplierReference: r.vendor_reference,
      amount: Number(r.amount), taxableAmount: Number(r.taxable_amount), taxAmount: Number(r.tax_amount), vatRate: Number(r.vat_rate),
      finalised: r.allocation_id != null,
    }));
  },

  // ── approval (called from the ONE bill approval path, bills.approvable) ──

  /**
   * Approve an advance invoice: re-check under the payment's lock that it is
   * still an advance and the amount is still un-invoiced, then CLAIM the VAT:
   * Dr Input VAT / Cr Supplier advances. The advance asset falls to its net
   * (a non-financial prepayment, IAS 32 AG11); the recoverable VAT leaves it
   * (IAS 2.11 / IAS 16.16(a) — recoverable taxes are not part of a cost).
   */
  async approveAdvanceInvoice(bill: typeof billsTable.$inferSelect): Promise<void> {
    const { supplierPaymentsService } = await import("./supplierPayments.service.js");
    const payment = await lockPayment(bill.advanceSupplierPaymentId!);
    if (payment.classification !== "advance") refuse("advance_invoice_requires_advance", "The payment this invoice is against is no longer classified as an advance.", "classification", 409);
    const f = await this.figures(payment, await supplierPaymentsService.availableOf(payment.id));
    if (Number(bill.total) > f.uninvoicedAmount + 0.005) {
      refuse("advance_invoice_exceeds_uninvoiced", `Only ${f.uninvoicedAmount.toFixed(2)} of the advance is still un-invoiced; this invoice is ${Number(bill.total).toFixed(2)}.`, "total", 409);
    }
    await checkPeriodOpen(bill.date);
    const vat = Number(bill.vatAmount);
    if (vat > 0) {
      const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, payment.vendorId)).limit(1);
      await postJournalEntry({
        entryNumber: `BILLADV-${bill.billNumber}`,
        date: bill.date,
        description: `Supplier advance tax invoice ${bill.vendorReference ?? bill.billNumber}${vendor ? ` – ${vendor.name}` : ""}`,
        reference: bill.billNumber,
        lines: [
          { systemCode: "VAT_INPUT", accountName: "Input VAT Receivable", description: `Input VAT on advance invoice ${bill.billNumber}`, debitAmount: vat, creditAmount: 0 },
          { systemCode: "SUPPLIER_ADVANCES", accountName: SUPPLIER_ON_ACCOUNT_ASSET_NAME.SUPPLIER_ADVANCES!, description: `VAT invoiced on advance ${bill.billNumber}`, debitAmount: 0, creditAmount: vat, party: { type: "vendor" as const, vendorId: payment.vendorId } },
        ],
      });
    }
  },

  /** Approve a credit note against an advance invoice: Dr Supplier advances / Cr Input VAT, in the note's period. */
  async approveAdvanceCreditNote(bill: typeof billsTable.$inferSelect): Promise<void> {
    const [inv] = await advanceInvoicesOpen({ ids: [bill.creditNoteAgainstBillId!] });
    if (!inv) refuse("advance_invoice_unknown", "The advance invoice this note credits is not approved.", "creditNoteAgainstBillId", 409);
    await lockPayment(inv!.supplierPaymentId);
    const [again] = await advanceInvoicesOpen({ ids: [inv!.id] });
    if (Number(bill.total) > again!.open + 0.005 || Number(bill.vatAmount) > again!.openTax + 0.005) {
      refuse("credit_exceeds_open_advance_invoice", `${again!.billNumber} has ${again!.open.toFixed(2)} still open; this note credits ${Number(bill.total).toFixed(2)}.`, "total", 409);
    }
    await checkPeriodOpen(bill.date);
    const vat = Number(bill.vatAmount);
    if (vat > 0) {
      await postJournalEntry({
        entryNumber: `BILLADVCN-${bill.billNumber}`,
        date: bill.date,
        description: `Supplier credit note ${bill.vendorReference ?? bill.billNumber} against advance invoice ${again!.billNumber}`,
        reference: bill.billNumber,
        lines: [
          { systemCode: "SUPPLIER_ADVANCES", accountName: SUPPLIER_ON_ACCOUNT_ASSET_NAME.SUPPLIER_ADVANCES!, description: `VAT credited on advance ${again!.billNumber}`, debitAmount: vat, creditAmount: 0, party: { type: "vendor" as const, vendorId: bill.vendorId! } },
          { systemCode: "VAT_INPUT", accountName: "Input VAT Receivable", description: `Input VAT reversed — ${bill.billNumber}`, debitAmount: 0, creditAmount: vat },
        ],
      });
    }
  },

  /**
   * For a final bill with prepayment rows: re-check them under every advance
   * payment's lock (in id order), and return what the bill's entry must net —
   * the VAT already claimed, the taxable part to release from the advance
   * asset, and the part of the total the advance settles.
   */
  async lockAndCheckFinalBill(bill: typeof billsTable.$inferSelect): Promise<(FinalBillCheck & { rows: unknown[] }) | null> {
    const rows = await db.select().from(billPrepaymentsTable).where(eq(billPrepaymentsTable.billId, bill.id));
    if (rows.length === 0) return null;
    const advIds = rows.map((r) => r.advanceBillId);
    const invs = await advanceInvoicesOpen({ ids: advIds });
    for (const pid of [...new Set(invs.map((i) => i.supplierPaymentId))].sort((a, b) => a - b)) await lockPayment(pid);
    const prepared = await this.preparePrepayments(
      rows.map((r) => ({ advanceBillId: r.advanceBillId, amount: Number(r.amount), taxAmount: Number(r.taxAmount) })),
      { vendorId: bill.vendorId, date: bill.date, subtotal: Number(bill.subtotal), vatAmount: Number(bill.vatAmount), total: Number(bill.total), documentType: bill.documentType, capitalisesAssetId: bill.capitalisesAssetId },
    );
    const sum = (f: (p: PreparedPrepayment) => number) => round2(prepared.reduce((s, p) => s + f(p), 0));
    return { rows, prepared, amount: sum((p) => p.amount), taxable: sum((p) => p.taxableAmount), tax: sum((p) => p.taxAmount) };
  },

  /** After the final bill's entry posts: one folded allocation per advance payment, naming that entry. */
  async finaliseFinalBill(billId: number, check: FinalBillCheck, entryId: number, userId: number | null) {
    const { supplierPaymentsService } = await import("./supplierPayments.service.js");
    const byPayment = new Map<number, PreparedPrepayment[]>();
    for (const p of check.prepared) byPayment.set(p.supplierPaymentId, [...(byPayment.get(p.supplierPaymentId) ?? []), p]);
    for (const [paymentId, list] of byPayment) {
      const amount = round2(list.reduce((s, p) => s + p.amount, 0));
      const [alloc] = await db.insert(supplierPaymentAllocationsTable).values({
        supplierPaymentId: paymentId, billId, amount: money2(amount), journalEntryId: entryId, createdBy: userId,
      }).returning();
      await db.update(billPrepaymentsTable).set({ allocationId: alloc!.id })
        .where(and(eq(billPrepaymentsTable.billId, billId), inArray(billPrepaymentsTable.advanceBillId, list.map((p) => p.advanceBillId))));
    }
    await supplierPaymentsService.refreshBill(billId);
  },

  /** Is this allocation a final bill's folded prepayment adjustment? (Those are corrected by a credit note, never undone.) */
  async isPrepaymentAllocation(allocationId: number): Promise<boolean> {
    const [row] = await db.select({ id: billPrepaymentsTable.id }).from(billPrepaymentsTable).where(eq(billPrepaymentsTable.allocationId, allocationId)).limit(1);
    return !!row;
  },

  async assertExists(billId: number) {
    const [b] = await db.select().from(billsTable).where(eq(billsTable.id, billId)).limit(1);
    if (!b) throw new NotFoundError("Bill not found.");
    return b;
  },
};
