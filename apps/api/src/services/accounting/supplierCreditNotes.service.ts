/**
 * SUPPLIER CREDIT NOTES — APPLYING THE PURCHASE-SIDE NOTE
 * (Phase 11 Part 2 — B7, 2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §13.
 *
 * 🔴 CREATION IS NOT HERE. A purchase note is a `bills` row, so it is entered
 * and approved through the bill path like any other purchase document —
 * `billsService.create` (guarded by `assertPurchaseNote`, which is where the
 * VAT reasoning and the ceiling live) and `billsService.approve`, which posts
 * it MIRRORED through `documentSign`. A second creation path for the same row
 * is exactly the thing this codebase refuses; this file owns only what a note
 * does AFTER it is in the books.
 *
 * ── 🔴 WHY APPLYING A NOTE POSTS NOTHING ───────────────────────────────────
 * An approved note has ALREADY moved the GL: Dr AP / Cr expense / Cr input
 * VAT. Its unapplied balance is a DEBIT sitting in AP for that supplier —
 * which is precisely what it is: the supplier owes us. Applying it to a bill
 * therefore answers "which payable does this note settle", and posts NOTHING,
 * because a second entry would move AP twice for one economic event.
 *
 * This is NOT symmetrical with an ADVANCE, and the asymmetry is the point: an
 * advance sits on its own asset account and must be MOVED INTO AP when it is
 * applied. Where each balance already sits decides whether applying it posts.
 *
 * Both reference implementations place it the same way — cited because the
 * escalation protocol asks for source, not recollection:
 *   · ERPNext — a return (`is_return = 1`) Purchase Invoice debits the
 *     Creditors account, and `reconcile_against_document` links it to the
 *     original through the reconciliation tooling, writing no GL Entry for the
 *     link itself.
 *   · Odoo — an `in_refund` move posts to Account Payable, and reconciling it
 *     against a vendor bill is a reconciliation over existing move lines; it
 *     creates no new `account.move`.
 * The GL placement carries no Saudi/VAT consequence (the tax consequence is
 * the PERIOD, settled in `purchaseNotePolicy`), so it is a product decision
 * taken here rather than a question for the accountant.
 */
import { eq, sql } from "drizzle-orm";
import { db, billsTable, supplierPaymentAllocationsTable, vendorsTable } from "@workspace/db";
import { BusinessRuleError, NotFoundError } from "../../lib/errors.js";
import { round2 } from "../../lib/money.js";
import { auditService } from "../audit.service.js";
import { supplierPaymentsService } from "./supplierPayments.service.js";

const refuse = (code: string, error: string, field?: string, status = 422): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}) });
};

export const supplierCreditNotesService = {
  /**
   * Apply an approved note's balance to the supplier's bills. Records which
   * payable the note answers; posts nothing (see the file header).
   */
  async apply(noteId: number, body: { allocations?: unknown }, userId: number | null) {
    // 🔴 Locked: the note's unapplied balance is read, checked and spent under
    // one row lock, so two concurrent applications cannot both spend it.
    const note = await this.findNoteOrThrow(noteId, { lock: true });
    if (note.documentType !== "credit_note") {
      refuse("not_a_credit_note", "A DEBIT note is an additional charge, not a balance to apply — it is payable like a bill.", "id", 409);
    }
    if (["draft", "submitted"].includes(note.status)) {
      refuse("note_not_approved", `Credit note ${note.billNumber} is ${note.status}; it moves nothing until it is approved.`, "id", 409);
    }
    const available = await this.availableOf(noteId);
    const requested = Array.isArray(body.allocations) ? (body.allocations as { billId: number; amount: number }[]) : [];
    if (requested.length === 0) refuse("allocations_required", "Name at least one bill to apply this note to.", "allocations");
    if (requested.some((r) => Number(r.billId) === noteId)) {
      refuse("note_against_itself", "A note cannot be applied to itself.", "allocations", 409);
    }

    // 🔴 The SAME validator the payment path uses: the bill must be this
    // supplier's, approved, and must still owe at least what is applied. One
    // definition of "may this amount be applied to this bill", not two that
    // drift.
    const allocations = await supplierPaymentsService.validateAllocations(requested, note.vendorId!, available);

    for (const a of allocations) {
      await db.insert(supplierPaymentAllocationsTable).values({
        supplierCreditNoteId: noteId, billId: a.billId, amount: String(a.amount),
        journalEntryId: null, createdBy: userId,
      });
      await supplierPaymentsService.refreshBill(a.billId);
    }
    await auditService.record({
      action: "apply", entityType: "supplier_credit_note", entityId: String(noteId),
      before: null, after: { allocations, journalEntryId: null },
    });
    return this.getById(noteId);
  },

  // ── reads ────────────────────────────────────────────────────────────────

  async findNoteOrThrow(id: number, opts: { lock?: boolean } = {}) {
    const q = db.select().from(billsTable).where(eq(billsTable.id, id)).limit(1);
    const [row] = opts.lock ? await q.for("update") : await q;
    if (!row) throw new NotFoundError("Note not found.");
    // Z-AP1: a note against a supplier's ADVANCE tax invoice is not an AP note — it has its own path.
    if (row.documentType !== "credit_note" && row.documentType !== "debit_note") refuse("not_a_note", `Document ${row.billNumber} is not a supplier credit or debit note.`, "id", 409);
    return row;
  },

  /** What a note still has to give — DERIVED: its total less what has been applied. */
  async availableOf(noteId: number): Promise<number> {
    const [row] = await db.execute<{ v: string }>(sql`
      SELECT (b.total
              - coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a
                           WHERE a.supplier_credit_note_id = b.id
                             AND NOT EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals r WHERE r.allocation_id = a.id)), 0))::text v
         FROM bills b WHERE b.id = ${noteId}`).then((r) => r.rows);
    return round2(Number(row?.v ?? 0));
  },

  async getById(id: number) {
    const note = await this.findNoteOrThrow(id);
    const [vendor] = note.vendorId
      ? await db.select().from(vendorsTable).where(eq(vendorsTable.id, note.vendorId)).limit(1)
      : [null];
    const applications = await db.execute<{ id: number; bill_id: number; bill_number: string; amount: string; reversed: boolean }>(sql`
      SELECT a.id, a.bill_id, b.bill_number, a.amount::text amount,
             EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals r WHERE r.allocation_id = a.id) reversed
        FROM supplier_payment_allocations a JOIN bills b ON b.id = a.bill_id
       WHERE a.supplier_credit_note_id = ${id} ORDER BY a.id`);
    return {
      id: note.id, billNumber: note.billNumber, documentType: note.documentType,
      creditNoteAgainstBillId: note.creditNoteAgainstBillId,
      vendorId: note.vendorId, vendorName: vendor?.name ?? null,
      date: note.date, status: note.status,
      subtotal: Number(note.subtotal), vatAmount: Number(note.vatAmount), total: Number(note.total),
      availableAmount: note.documentType === "credit_note" ? await this.availableOf(id) : 0,
      applications: applications.rows.map((a) => ({
        id: a.id, billId: a.bill_id, billNumber: a.bill_number,
        amount: Number(a.amount), reversed: a.reversed,
      })),
    };
  },

  async list(filter: { vendorId?: number } = {}) {
    const rows = await db.execute<{ id: number }>(sql`
      SELECT b.id FROM bills b
       WHERE b.document_type IN ('credit_note', 'debit_note')
         ${filter.vendorId ? sql`AND b.vendor_id = ${filter.vendorId}` : sql``}
       ORDER BY b.id`);
    const items = [];
    for (const r of rows.rows) items.push(await this.getById(r.id));
    return { items };
  },
};
