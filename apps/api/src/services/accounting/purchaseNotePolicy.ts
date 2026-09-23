/**
 * WHAT A PURCHASE-SIDE NOTE MAY BE (Phase 11 Part 2 — B7, 2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §13.
 *
 * 🔴 THIS RUNS AT THE BILL WRITE BOUNDARY, not in a "supplier credit notes"
 * service beside it. A note is a `bills` row; every writer of that table —
 * `POST /bills`, a future import, whatever the next path turns out to be —
 * passes through `billsService.create`, so the rule lives where the row is
 * written rather than in one caller that happens to remember it. Per-path
 * enforcement is per-path review, and a new path starts at zero.
 *
 * 🔴 WE RECEIVE THIS DOCUMENT; WE DO NOT ISSUE IT. The VAT Implementing
 * Regulations put the obligation to issue a credit or debit note on "the
 * Taxable Person who has made the supply" — on a purchase our tenant is the
 * CUSTOMER. No ICV is consumed, no QR is minted, no position is taken in the
 * ZATCA hash chain, nothing is queued to the outbox. That is the whole
 * difference from `invoices.document_type`, which looks identical and is not.
 *
 * 🔴 THE PERIOD IS THE SUPPLIER'S. IR Art. 40(6) has the CUSTOMER correct its
 * Input Tax "in the Tax Period in which the Credit Note or Debit Note is
 * issued", so a note carries its OWN date — the supplier's issue date — and
 * the VAT return reads that. It is deliberately NOT defaulted from the
 * original bill: doing so would file the correction in the period of the
 * supply, which is the one thing the article settles.
 */
import { eq, sql } from "drizzle-orm";
import { db, billsTable } from "@workspace/db";
import { BusinessRuleError } from "../../lib/errors.js";
import { round2 } from "../../lib/money.js";

export const PURCHASE_DOCUMENT_TYPES = ["bill", "credit_note", "debit_note"] as const;

const refuse = (code: string, error: string, field?: string, status = 422): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}) });
};

/** How much of one bill has already been credited by notes that are IN the books. */
export async function creditedAgainst(billId: number, excludeNoteId?: number): Promise<number> {
  const [row] = await db.execute<{ v: string }>(sql`
    SELECT coalesce(sum(b.total), 0)::text v FROM bills b
     WHERE b.credit_note_against_bill_id = ${billId}
       AND b.document_type = 'credit_note'
       AND b.status NOT IN ('draft', 'submitted')
       ${excludeNoteId ? sql`AND b.id <> ${excludeNoteId}` : sql``}`).then((r) => r.rows);
  return round2(Number(row?.v ?? 0));
}

/**
 * Check a purchase note against the bill it adjusts, and return the original so
 * the caller can inherit its supplier. A plain bill passes through untouched.
 */
export async function assertPurchaseNote(
  documentType: unknown,
  againstBillId: unknown,
  total: number,
  opts: { excludeNoteId?: number } = {},
): Promise<{ vendorId: number | null } | null> {
  const type = String(documentType ?? "bill");
  if (!(PURCHASE_DOCUMENT_TYPES as readonly string[]).includes(type)) {
    refuse("document_type_unknown", "A purchase document is a bill, a credit note or a debit note.", "documentType");
  }
  if (type === "bill") {
    // 🔴 Both halves of the XOR, refused in words here as well as by the CHECK
    // constraint: a bill naming a document it adjusts is a note somebody forgot
    // to type, and the error should say so rather than read as a database fault.
    if (againstBillId != null && againstBillId !== "") {
      refuse("against_bill_on_a_bill", "An ordinary bill adjusts nothing. Set the document type to a credit or debit note, or remove the bill it points at.", "creditNoteAgainstBillId");
    }
    return null;
  }

  const againstId = Number(againstBillId);
  if (!Number.isInteger(againstId) || againstId <= 0) {
    refuse("against_bill_required", "A purchase note adjusts a bill. Name the bill it corrects.", "creditNoteAgainstBillId");
  }
  const [original] = await db.select().from(billsTable).where(eq(billsTable.id, againstId)).limit(1);
  if (!original) refuse("bill_unknown", `Bill ${againstId} does not exist in this company.`, "creditNoteAgainstBillId");
  if (original!.documentType !== "bill") {
    refuse("against_not_a_bill", "A note adjusts a BILL, not another note.", "creditNoteAgainstBillId", 409);
  }
  if (["draft", "submitted"].includes(original!.status)) {
    refuse("bill_not_approved", `Bill ${original!.billNumber} is ${original!.status} and carries no payable to adjust yet.`, "creditNoteAgainstBillId", 409);
  }

  /**
   * 🔴 The ceiling for a CREDIT note is what the bill was CHARGED, less what
   * other notes have already credited — not what it still owes. A bill already
   * PAID can be credited in full: the supplier owes the money back, and the
   * note's balance then sits as a debit in AP until it is applied elsewhere or
   * refunded. What a note may not do is credit more than was ever charged.
   *
   * A DEBIT note has no such ceiling: it is an ADDITIONAL charge, not a
   * reversal, and a supplier may charge more than the original at any time.
   */
  if (type === "credit_note") {
    const ceiling = round2(Number(original!.total) - (await creditedAgainst(againstId, opts.excludeNoteId)));
    if (total > ceiling + 0.005) {
      refuse(
        "credit_exceeds_bill",
        `Bill ${original!.billNumber} was charged ${Number(original!.total).toFixed(2)} and has ${ceiling.toFixed(2)} left to credit; ${total.toFixed(2)} was entered.`,
        "total", 409,
      );
    }
  }
  return { vendorId: original!.vendorId };
}
