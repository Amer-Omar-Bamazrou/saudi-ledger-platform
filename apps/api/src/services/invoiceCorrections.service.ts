/**
 * 🔴 Phase 18 — THE PR C CORRECTION ROUTE for an invoice ZATCA rejected (owner
 * decision 2 of 2026-10-27, constraints (a)–(e); final-run memo §2 E; design:
 * the evidence `2026-10-27-prc-route/DESIGN.md`, register §11.35).
 *
 *  1. An approver RECORDS the rejection, with ZATCA's response attached
 *     (append-only). Nothing posts; nothing on the invoice or its entry changes:
 *     "no automatic VAT reversal on rejection".
 *  2. The rejected invoice is corrected by a NEW invoice that names it
 *     (`corrects_invoice_id`, the link on the NEW row): its own number, ICV,
 *     hash and UUID, never a credit note. Same customer, same date (the
 *     supply's tax point).
 *  3. At the correction's issue, a NEW entry mirrors the rejected invoice's own
 *     posted entry, line for line, on the same date; with the correction's own
 *     entry the books hold the sale ONCE, at the corrected figures, in the tax
 *     point's period. The frozen entry (G16) and the frozen invoice (PR C) are
 *     never touched, and neither freeze is loosened.
 *  4. Once its correction is issued, a rejected invoice leaves every document
 *     report (reports.repository / receivableInBooks); it is never paid.
 *  5. A correction that is itself rejected repeats 1–4 (constraint (e)).
 */
import { db, invoiceRejectionsTable, journalEntriesTable, journalEntryLinesTable, invoicesTable, type Invoice } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { INVOICE_IN_BOOKS_STATUSES } from "@workspace/shared";
import { BusinessRuleError, NotFoundError } from "../lib/errors";
import { invoicesRepository } from "../repositories/invoices.repository";
import { einvoiceDocumentsRepository } from "../repositories/einvoiceDocuments.repository";
import { advanceInvoicesRepository } from "../repositories/advanceInvoices.repository";
import { postJournalEntry, type GLLine } from "./accounting/glPosting";
import { auditService } from "./audit.service";
import { buildInvoiceOut } from "./invoices.presenter";

const ACCEPTED = new Set(["cleared", "reported"]);
const isIssuedInvoice = (inv: Invoice) =>
  inv.documentType === "invoice" && !inv.isOpening && (INVOICE_IN_BOOKS_STATUSES as readonly string[]).includes(inv.status);

const required = (v: unknown, code: string, field: string, what: string): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new BusinessRuleError(422, { code, field, error: `${what} is required to record a rejection. Nothing was recorded.` });
  return s;
};

async function findInvoice(id: number): Promise<Invoice> {
  const [inv] = await invoicesRepository.findById(id);
  if (!inv) throw new NotFoundError("Not found");
  return inv;
}

/** The rejection recorded for an invoice, or null. */
export async function rejectionOf(invoiceId: number) {
  const [row] = await db.select().from(invoiceRejectionsTable).where(eq(invoiceRejectionsTable.invoiceId, invoiceId)).limit(1);
  return row ?? null;
}

/** The correction that names an invoice (the newest: an issued one, or a draft), or null. */
async function correctionOf(invoiceId: number) {
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.correctsInvoiceId, invoiceId)).orderBy(desc(invoicesTable.id)).limit(1);
  return row ?? null;
}

export const rejectionOut = (r: NonNullable<Awaited<ReturnType<typeof rejectionOf>>>) => ({
  id: r.id,
  invoiceId: r.invoiceId,
  zatcaResponse: r.zatcaResponse,
  reason: r.reason,
  zatcaRejectedAt: r.zatcaRejectedAt ? r.zatcaRejectedAt.toISOString() : null,
  recordedBy: r.recordedBy ?? null,
  recordedAt: r.recordedAt.toISOString(),
});

/** What a single-invoice read adds: its rejection and its correction (issued or draft). */
export async function correctionStateOf(invoiceId: number) {
  const rejection = await rejectionOf(invoiceId);
  const correction = rejection ? await correctionOf(invoiceId) : null;
  return { rejection: rejection ? rejectionOut(rejection) : null, correctedByInvoiceId: correction?.id ?? null };
}

/** The pay path's refusal: a rejected invoice is never paid; its correction is. */
export async function assertNotRejected(inv: Pick<Invoice, "id" | "invoiceNumber">): Promise<void> {
  if (!(await rejectionOf(inv.id))) return;
  const correction = await correctionOf(inv.id);
  throw new BusinessRuleError(409, {
    code: "invoice_rejected",
    field: "id",
    error: correction
      ? `${inv.invoiceNumber} was rejected by ZATCA and is corrected by ${correction.invoiceNumber}; record the payment against the correction. Nothing was recorded.`
      : `${inv.invoiceNumber} was rejected by ZATCA. Issue its correction first, then record the payment against the correction. Nothing was recorded.`,
  });
}

export const invoiceCorrectionsService = {
  /** An approver records ZATCA's rejection, with ZATCA's response attached. Nothing posts. */
  async recordRejection(id: number, body: { zatcaResponse?: unknown; reason?: unknown; zatcaRejectedAt?: unknown }, userId: number | null) {
    const zatcaResponse = required(body.zatcaResponse, "zatca_response_required", "zatcaResponse", "ZATCA's response");
    const reason = required(body.reason, "rejection_reason_required", "reason", "The reason");
    let zatcaRejectedAt: Date | null = null;
    if (body.zatcaRejectedAt != null && body.zatcaRejectedAt !== "") {
      zatcaRejectedAt = new Date(String(body.zatcaRejectedAt));
      if (Number.isNaN(zatcaRejectedAt.getTime())) {
        throw new BusinessRuleError(422, { code: "date_invalid", field: "zatcaRejectedAt", error: "zatcaRejectedAt is a date and time (ISO 8601), as ZATCA reported it. Nothing was recorded." });
      }
    }
    const inv = await findInvoice(id);
    if (!isIssuedInvoice(inv)) {
      throw new BusinessRuleError(409, { code: "invoice_not_issued", field: "id", error: `${inv.invoiceNumber} is not an issued tax invoice, so ZATCA has not rejected it. Nothing was recorded.` });
    }
    const doc = await einvoiceDocumentsRepository.findByInvoice(id);
    if (!doc) {
      throw new BusinessRuleError(409, { code: "invoice_not_submitted", field: "id", error: `${inv.invoiceNumber} has no ZATCA submission, so there is no rejection to record. Nothing was recorded.` });
    }
    if (ACCEPTED.has(doc.status)) {
      throw new BusinessRuleError(409, { code: "invoice_accepted_by_zatca", field: "id", error: `ZATCA accepted ${inv.invoiceNumber} (${doc.status}); an accepted invoice is corrected by a credit or debit note, not as a rejection. Nothing was recorded.` });
    }
    if (await rejectionOf(id)) {
      throw new BusinessRuleError(409, { code: "invoice_already_rejected", field: "id", error: `A rejection of ${inv.invoiceNumber} is already recorded. Nothing was recorded.` });
    }
    if (Number(inv.paidAmount ?? 0) > 0 || Number(inv.creditedAmount ?? 0) > 0) {
      throw new BusinessRuleError(409, {
        code: "rejected_invoice_has_payments",
        field: "id",
        error: `${inv.invoiceNumber} has payments or credits applied. A rejected invoice is never paid; moving what was applied to its correction is not built, so the rejection is not recorded. Nothing was recorded.`,
      });
    }
    const [row] = await db.insert(invoiceRejectionsTable).values({
      invoiceId: id, einvoiceDocumentId: doc.id, zatcaResponse, reason, zatcaRejectedAt, recordedBy: userId,
    }).returning();
    await auditService.created("invoice_rejection", row!.id, row);
    return rejectionOut(row!);
  },

  /** The DRAFT invoice that corrects a rejected invoice: same customer and date, the lines to correct. */
  async createCorrection(id: number, userId: number | null) {
    const inv = await findInvoice(id);
    if (!(await rejectionOf(id))) {
      throw new BusinessRuleError(409, { code: "invoice_not_rejected", field: "id", error: `${inv.invoiceNumber} has no recorded rejection; only a rejected invoice is corrected by a new invoice. Nothing was created.` });
    }
    const existing = await correctionOf(id);
    if (existing) {
      throw new BusinessRuleError(409, { code: "invoice_already_corrected", field: "id", error: `${inv.invoiceNumber} is already corrected by ${existing.invoiceNumber}. Nothing was created.` });
    }
    if ((await advanceInvoicesRepository.prepaymentsOfInvoice(id)).length > 0) {
      throw new BusinessRuleError(409, {
        code: "correction_of_advance_adjusted_invoice",
        field: "id",
        error: `${inv.invoiceNumber} adjusts advance tax invoices; correcting it is not built (its advance adjustments need their own design). Nothing was created.`,
      });
    }
    const invoiceNumber = await invoicesRepository.allocateInvoiceNumber(inv.date);
    const [doc] = await invoicesRepository.insert({
      invoiceNumber,
      date: inv.date,
      dueDate: inv.dueDate,
      customerId: inv.customerId,
      documentType: "invoice",
      correctsInvoiceId: inv.id,
      subtotal: inv.subtotal,
      vatAmount: inv.vatAmount,
      discount: inv.discount,
      total: inv.total,
      currency: inv.currency,
      status: "draft",
      notes: inv.notes,
      termsAndConditions: inv.termsAndConditions,
      createdBy: userId ?? null,
    } as Parameters<typeof invoicesRepository.insert>[0]);
    const items = await invoicesRepository.itemsByInvoice(inv.id);
    if (items.length > 0) {
      await invoicesRepository.insertItems(items.map(({ id: _id, invoiceId: _invoice, createdAt: _at, organizationId: _org, companyId: _co, ...rest }) => ({ ...rest, invoiceId: doc!.id })) as Parameters<typeof invoicesRepository.insertItems>[0]);
    }
    await auditService.created("invoice", doc!.id, { ...doc, correctsInvoiceId: inv.id });
    return buildInvoiceOut(doc!, null, await invoicesRepository.itemsByInvoice(doc!.id));
  },
};

/**
 * Before a correction's ICV is consumed (a refused issuance is recoverable; an
 * ICV gap is not): it names a rejected invoice of its own customer and date,
 * not already corrected by an issued invoice. The database holds the same rule
 * at the issuing write (0134); this is its readable form.
 */
export async function assertCorrectionIssuable(inv: Invoice): Promise<void> {
  if (inv.correctsInvoiceId == null) return;
  const [prev] = await invoicesRepository.findById(inv.correctsInvoiceId);
  const issuedCorrections = prev
    ? await db.select({ id: invoicesTable.id, n: invoicesTable.invoiceNumber }).from(invoicesTable)
        .where(and(eq(invoicesTable.correctsInvoiceId, prev.id), inArray(invoicesTable.status, [...INVOICE_IN_BOOKS_STATUSES])))
    : [];
  const why = !prev
    ? "the invoice it corrects does not exist"
    : !(await rejectionOf(prev.id))
      ? `${prev.invoiceNumber} has no recorded rejection`
      : prev.customerId !== inv.customerId
        ? `it names another customer than ${prev.invoiceNumber}`
        : prev.date !== inv.date
          ? `its date is not ${prev.invoiceNumber}'s (${prev.date}), the supply's tax point`
          : issuedCorrections.length > 0
            ? `${prev.invoiceNumber} is already corrected by ${issuedCorrections[0]!.n}`
            : null;
  if (why) {
    throw new BusinessRuleError(409, { code: "invoice_correction_invalid", field: "correctsInvoiceId", error: `This correction cannot be issued: ${why}. Nothing was issued.` });
  }
}

/**
 * At a correction's issue: a NEW entry mirroring the rejected invoice's own
 * posted entry, line for line, on the same date (constraint (a): the frozen
 * entry is never touched, no `reversal_of`, no status flip). With the
 * correction's own entry, the books hold the sale once.
 */
export async function mirrorRejectedInvoiceEntries(inv: Invoice): Promise<void> {
  if (inv.correctsInvoiceId == null) return;
  const [prev] = await invoicesRepository.findById(inv.correctsInvoiceId);
  if (!prev) return; // assertCorrectionIssuable refused this already
  const entries = await db.select().from(journalEntriesTable)
    .where(and(eq(journalEntriesTable.sourceType, "invoice"), eq(journalEntriesTable.sourceId, prev.id)));
  if (entries.some((e) => e.status !== "posted")) {
    throw new BusinessRuleError(409, {
      code: "invoice_correction_invalid",
      field: "correctsInvoiceId",
      error: `${prev.invoiceNumber}'s entry is not a plain posted entry (it was reversed), so its sale cannot be carried by a correction. Nothing was issued.`,
    });
  }
  let k = 0;
  for (const e of entries) {
    const lines = await db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.journalEntryId, e.id));
    const mirrored: GLLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      accountName: l.accountName,
      description: `Correction ${inv.invoiceNumber} replaces rejected ${prev.invoiceNumber}${l.description ? ` — ${l.description}` : ""}`,
      debitAmount: Number(l.creditAmount),
      creditAmount: Number(l.debitAmount),
      // The mirror says exactly what the original line said about its party.
      party: l.customerId != null
        ? { type: "customer" as const, customerId: l.customerId }
        : l.vendorId != null
          ? { type: "vendor" as const, vendorId: l.vendorId }
          : { type: "none" as const, reason: `mirrors a line of ${prev.invoiceNumber} that names no party` },
    }));
    await postJournalEntry({
      sourceType: "invoice_correction",
      sourceId: inv.id,
      entryNumber: `GL-${prev.invoiceNumber}-C${inv.id}${k > 0 ? `-${k}` : ""}`,
      date: prev.date,
      description: `Correction ${inv.invoiceNumber} replaces ${prev.invoiceNumber}, rejected by ZATCA — the rejected invoice's entry mirrored; the sale stands once, on the correction`,
      reference: inv.invoiceNumber,
      lines: mirrored,
    });
    k++;
  }
}
