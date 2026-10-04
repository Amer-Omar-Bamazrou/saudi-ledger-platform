/**
 * Bills service — AP bills and the draft/approval workflow (M10.3).
 *
 * The draft→submitted→approved transitions are delegated to the generic
 * {@link approvalService} via the per-request {@link billApprovable} adapter —
 * the SAME engine journal entries use. Approval fires the bill's existing
 * post-to-GL activation (totals reconciliation + ZATCA validation + Dr
 * Purchases/Input VAT / Cr AP), unchanged, now living in the adapter. `post`
 * is kept as the alias for `approve` (the frontend and existing API call it).
 *
 * `pay` is a post-approval action (not part of the workflow) and is hardened
 * here: a bill must be approved before payment, the amount must be a positive
 * number (fixing the pre-existing 500 when it was missing/invalid), and the
 * payment posts Dr AP / Cr Cash.
 */
import { DEFAULT_VAT_RATE } from "@workspace/shared";
import { documentNumbersRepository } from "../repositories/documentNumbers.repository";
import { assertNotReversedOpening, assertNotReservedOpeningNumber } from "./accounting/openingReversed";
import { assertPurchaseNote } from "./accounting/purchaseNotePolicy";
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from "../lib/errors";
import { pick, assertAmount, assertRate, assertDateString } from "../lib/writeGuards";
import { vendorsRepository } from "../repositories/vendors.repository";
import { categoriesRepository } from "../repositories/categories.repository";

/**
 * MED (audit 2026-08-20): the vendor twin of invoices' assertCustomerExists —
 * a nonexistent vendorId was a raw FK 500, and the RLS-blind FK check accepted
 * another tenant's vendor id. Tenant-scoped lookup; 422 (semantically invalid
 * input that passed schema validation — status policy, 2026-08-23).
 */
/** The chosen expense account must be one of THIS tenant's expense accounts (RLS scopes the read). */
async function assertExpenseAccount(id: unknown): Promise<void> {
  const n = Number(id);
  const cat = Number.isInteger(n) && n > 0 ? await categoriesRepository.findById(n) : null;
  if (!cat || cat.type !== "expense") {
    throw new BusinessRuleError(422, {
      error: `Expense account #${String(id)} is not an expense account in this company's chart of accounts.`,
      code: "expense_account_unresolved",
      field: "expenseAccountId",
    });
  }
}

/**
 * 🔴 Phase 13C — an EXPENSE names the bank it was paid from and the date, and
 * it is a plain bill (a note or an advance document is never "paid when
 * recorded"). Checked here, where the row is written; the DB CHECK
 * `bills_expense_chk` is the backstop. Both fields are REQUIRED, never
 * defaulted — the paid date is not assumed to be the document date, and the
 * bank is never inferred (D-3).
 */
async function normaliseExpense(v: Record<string, any>, documentType: string): Promise<void> {
  if (v.recordedAsExpense !== true) {
    v.recordedAsExpense = false;
    v.expensePaidFromBankAccountId = null;
    v.expensePaidAt = null;
    return;
  }
  if (documentType !== "bill") {
    throw new BusinessRuleError(422, {
      code: "expense_must_be_bill",
      error: "Only a supplier bill can be recorded as an expense paid when recorded — a credit note, debit note or advance document is not.",
      field: "recordedAsExpense",
    });
  }
  v.expensePaidFromBankAccountId = await assertBankAccount(v.expensePaidFromBankAccountId, { field: "expensePaidFromBankAccountId", what: "the expense was paid from" });
  if (v.expensePaidAt == null || v.expensePaidAt === "") {
    throw new BusinessRuleError(422, { code: "expense_paid_at_required", error: "Enter the date the expense was paid.", field: "expensePaidAt" });
  }
  assertDateString(v.expensePaidAt, "expensePaidAt");
  // The payment posts on this date at approval — a closed month is refused NOW.
  await checkPeriodOpen(v.expensePaidAt);
}

/** Link a staged capture to a draft as its evidence; refused (not skipped) when it cannot be. */
async function linkEvidence(captureId: unknown, billId: number): Promise<void> {
  if (captureId == null || captureId === "") return;
  const linked = await capturedDocumentsRepository.linkToBill(String(captureId), billId);
  if (!linked) {
    throw new BusinessRuleError(422, {
      code: "capture_unavailable",
      error: "That document cannot be attached: it is already the evidence of another bill, has been posted, or was discarded.",
      field: "captureId",
    });
  }
}

async function assertVendorExists(vendorId: unknown): Promise<void> {
  if (vendorId == null) return;
  const [v] = await vendorsRepository.findById(Number(vendorId));
  if (!v) {
    throw new BusinessRuleError(422, {
      error: `Vendor ${vendorId} does not exist for this organization.`,
      code: "reference_not_found",
      field: "vendorId",
    });
  }
}
import { auditService } from "./audit.service";
import { postJournalEntry } from "./accounting/glPosting";
import { assertBankAccount } from "./accounting/bankIdentity";
import { checkPeriodOpen } from "./accounting/periodLock";
import { approvalService } from "./approval";
import { billApprovable, type BillApproveOptions } from "./bills.approvable";
import { payBill } from "./bills.payment";
import { buildBillOut } from "./bills.presenter";
import { billsRepository, DEFAULT_PAGE as BILL_PAGE, type BillListFilter } from "../repositories/bills.repository";
import { paymentsRepository } from "../repositories/payments.repository";
import { round2 } from "../lib/money";
import { taxRepository } from "../repositories/tax.repository";
import { businessToday } from "@workspace/shared";
import { supplierAdvanceInvoicesService, type PrepaymentInput } from "./accounting/supplierAdvanceInvoices.service";
import { capturedDocumentsRepository } from "../repositories/capturedDocuments.repository";
import { vatEvidenceService, assertSupplierDocumentKind } from "./purchaseEvidence/vatEvidence.service";
import { duplicatesService } from "./purchaseEvidence/duplicates.service";
import { captureService } from "./capture/capture.service";


export const billsService = {
  /** A PAGE of bills, plus the totals for the whole filtered set (see invoices). */
  async list(filter: BillListFilter) {
    const [rows, meta] = await Promise.all([
      billsRepository.list(filter),
      billsRepository.listMeta(filter),
    ]);
    return {
      items: rows.map((r) => buildBillOut(r.bill, r.vendor, undefined, r.outstanding, r.prepaid)),
      page: { limit: filter.limit ?? BILL_PAGE, offset: filter.offset ?? 0, total: meta.total },
      totals: { outstanding: round2(meta.outstanding), paid: round2(meta.paid), overdue: meta.overdue },
    };
  },

  async getById(id: number) {
    const [row] = await billsRepository.findWithVendor(id);
    if (!row) throw new NotFoundError("Not found");
    const items = await billsRepository.itemsByBill(id);
    const prepayments = await supplierAdvanceInvoicesService.prepaymentsOf(id);
    const capture = await capturedDocumentsRepository.activeForBill(id);
    return buildBillOut(row.bill, row.vendor, items, row.outstanding, row.prepaid, prepayments, capture);
  },

  async create(body: Record<string, any>, userId: number | null) {
    const { items = [] } = body;

    /**
     * A bill must RECORD something. `POST /bills` with `items: []` and no
     * totals returned 201 and created a SAR 0.00 liability (found with the
     * invoice case, 2026-08-28).
     *
     * 🔴 Deliberately weaker than the invoice rule, and the difference is not
     * an oversight: a bill legitimately has NO lines when it comes from the
     * capture path, where OCR reads header amounts off a photograph and the
     * line detail is not ours to invent. So the invariant here is "lines OR a
     * non-zero total", not "lines". An invoice is ours to issue and ZATCA wants
     * the detail; a supplier's bill is evidence we are recording.
     */
    const declaredTotal = Number(body.total ?? 0);
    if ((!Array.isArray(items) || items.length === 0) && !(declaredTotal > 0)) {
      throw new BusinessRuleError(400, {
        error: "A bill needs at least one line, or a total. A bill recording nothing cannot be posted.",
        code: "bill_records_nothing",
        field: "items",
      });
    }
    // 🔴 H1 — ALLOWLIST. `status` is forced to "draft" below; `paidAmount`/
    // `paidAt` are set by the pay path; a client sets only header fields (and,
    // for a no-items bill, the totals — validated ≥ 0). The raw spread let a
    // draft be created pre-"approved", payable against an AP balance never
    // posted (a permanent GL imbalance through the pay path).

    /**
     * 🔴 Server-allocated when the caller leaves it blank — the AUD-1 fix,
     * swept to the documents it originally missed.
     *
     * The browser used to mint `BILL-${Date.now().toString().slice(-6)}`, which
     * wraps every ~16.7 minutes onto a column with NO unique index: a collision
     * produced two financial records claiming to be the same document, and
     * nothing refused it. A caller-supplied number is still honoured (legacy
     * imports and a user who types their own); blank is what asks the server.
     */
    if (!String(body.billNumber ?? "").trim()) {
      body.billNumber = await documentNumbersRepository.allocate("bill");
    }
    assertNotReservedOpeningNumber(body.billNumber, "billNumber"); // Policy C: OPEN-<batch>-<n> belongs to migration replacements only

    const billData = pick<Record<string, unknown>>(body, [
      "billNumber", "vendorReference", "date", "dueDate", "vendorId", "currency",
      "notes", "reviewNote", "subtotal", "vatAmount", "total", "expenseAccountId", "capitalisesAssetId",
      // B7: a purchase-side note is a bills row. Both fields are checked
      // together by assertPurchaseNote below, at this write boundary.
      "documentType", "creditNoteAgainstBillId",
      // Phase 13A: the supplier document the user states they hold.
      "supplierDocumentKind",
      // Phase 13C: an expense — paid when recorded, from this bank, on this date.
      "recordedAsExpense", "expensePaidFromBankAccountId", "expensePaidAt",
    ]) as Record<string, any>;
    assertSupplierDocumentKind(billData.supplierDocumentKind);
    await normaliseExpense(billData, String(billData.documentType ?? "bill"));
    // The chosen expense account must be one of the tenant's EXPENSE accounts —
    // the same rule resolveExpenseLine applies at posting, checked at entry so
    // a wrong choice is refused when it is made, not when it is approved.
    if (billData.expenseAccountId != null) await assertExpenseAccount(billData.expenseAccountId);
    // 🔴 H2 — item amounts validated (see invoices.create).
    (items as any[]).forEach((it, i) => {
      assertAmount(it.quantity, `item ${i + 1} quantity`, { min: 0, allowZero: true });
      assertAmount(it.unitPrice, `item ${i + 1} unit price`, { min: 0, allowZero: true });
      if (it.vatRate != null) assertRate(it.vatRate, `item ${i + 1} VAT rate`);
    });
    if (billData.date != null) assertDateString(billData.date, "date");
    if (billData.dueDate != null) assertDateString(billData.dueDate, "dueDate");
    await assertVendorExists(billData.vendorId);
    // No-items bills carry client totals; keep them non-negative (finding 7's
    // reconciliation still runs at approval).
    for (const f of ["subtotal", "vatAmount", "total"] as const) {
      if (billData[f] != null) assertAmount(billData[f], f, { min: 0, allowZero: true });
    }
    // Audit fix (Tier 1, finding 2): header = Σ rounded lines, exactly — see
    // the full note in invoices.service.create; the same divergence existed
    // here and feeds AP GL posting and the input-VAT side of the return.
    let subtotal = 0;
    let vatTotal = 0;
    const preparedItems = items.map((it: any) => {
      const base = round2(Number(it.quantity) * Number(it.unitPrice));
      const vat = round2(base * (Number(it.vatRate ?? DEFAULT_VAT_RATE) / 100));
      subtotal = round2(subtotal + base);
      vatTotal = round2(vatTotal + vat);
      return {
        ...it,
        quantity: String(it.quantity),
        unitPrice: String(it.unitPrice),
        vatAmount: vat.toFixed(2),
        total: round2(base + vat).toFixed(2),
      };
    });

    // If no line items, trust the submitted subtotal/vatAmount/total values.
    const finalSubtotal = items.length > 0 ? subtotal : Number(billData.subtotal ?? 0);
    const finalVatAmount = items.length > 0 ? vatTotal : Number(billData.vatAmount ?? 0);
    const finalTotal = items.length > 0 ? subtotal + vatTotal : Number(billData.total ?? 0);

    /**
     * 🔴 B7 — a purchase note is checked HERE, where the row is written,
     * and not in a service beside this one: the ceiling, the original's state
     * and the XOR would otherwise hold on one path and be absent on the next.
     * The note also INHERITS the original's supplier — a note pointing at one
     * supplier's bill while naming another is not a thing that can be true, so
     * it is made inexpressible rather than refused.
     */
    const noteAgainst = await assertPurchaseNote(
      billData.documentType, billData.creditNoteAgainstBillId, finalTotal,
    );
    if (noteAgainst) billData.vendorId = noteAgainst.vendorId;

    await checkPeriodOpen(billData.date ?? businessToday());
    /**
     * Z-AP1 — a bill (the supplier's FINAL invoice) may deduct the supplier's
     * advance tax invoice(s). Checked here, at the write boundary, and again
     * under the advance payments' locks at approval; a draft reserves nothing.
     */
    const prepayments = Array.isArray(body.prepayments) && body.prepayments.length > 0
      ? await supplierAdvanceInvoicesService.preparePrepayments(body.prepayments as PrepaymentInput[], {
          vendorId: billData.vendorId ?? null, date: billData.date ?? businessToday(),
          subtotal: finalSubtotal, vatAmount: finalVatAmount, total: finalTotal,
          documentType: String(billData.documentType ?? "bill"), capitalisesAssetId: billData.capitalisesAssetId ?? null,
        })
      : [];
    const [bill] = await billsRepository.insert({
      ...billData,
      subtotal: String(finalSubtotal.toFixed(2)),
      vatAmount: String(finalVatAmount.toFixed(2)),
      total: String(finalTotal.toFixed(2)),
      // Every bill enters the workflow as a draft — it affects nothing until
      // approved. A caller-supplied status is ignored (workflow correctness).
      status: "draft",
      createdBy: userId ?? null,
    } as Parameters<typeof billsRepository.insert>[0]);

    if (preparedItems.length > 0) {
      await billsRepository.insertItems(preparedItems.map((it: any) => ({ ...it, billId: bill.id })));
    }
    if (prepayments.length > 0) await supplierAdvanceInvoicesService.writePrepayments(bill.id, prepayments);

    // 🔴 Phase 13A: the scanned document becomes this DRAFT's evidence (still
    // deletable staging — it is promoted only when the bill posts), and the
    // server's evidence verdict is written now, so a held draft is listed.
    await linkEvidence(body.captureId, bill.id);
    await vatEvidenceService.refresh(bill.id);

    await auditService.created("bill", bill.id, bill);
    return billsService.getById(bill.id);
  },

  /** Submit a draft bill into the approval queue (bookkeeper action). */
  submit(id: number, userId: number | null) {
    return approvalService.submit(billApprovable(), id, { userId: userId ?? null });
  },

  /** Send a submitted bill back to the enterer for correction (approver action). */
  sendBack(id: number, note: string | undefined, userId: number | null) {
    return approvalService.sendBack(billApprovable(), id, { userId: userId ?? null }, note);
  },

  /** Reject (hard-delete) a non-approved bill (approver action). */
  reject(id: number, userId: number | null) {
    return approvalService.reject(billApprovable(), id, { userId: userId ?? null });
  },

  /**
   * Approve a bill — posts it to the GL (AP/expense/input VAT). Runs the
   * existing activation via the bill adapter, carrying the request's post
   * options (debit account, force override). `post` is the alias.
   */
  approve(id: number, opts: BillApproveOptions, userId: number | null) {
    return approvalService.approve(billApprovable(opts), id, { userId: userId ?? null });
  },

  post(id: number, opts: BillApproveOptions, userId: number | null) {
    return this.approve(id, opts, userId);
  },

  async update(id: number, data: Record<string, unknown>) {
    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") throw new ConflictError("Only draft bills can be edited.");
    // Z-AP1: a supplier's advance document is derived from the payment (or the
    // advance invoice) it records; a wrong draft is rejected and re-entered.
    if (existing.documentType === "advance_invoice" || existing.documentType === "advance_credit_note") {
      throw new BusinessRuleError(409, { code: "advance_document_not_editable", error: "A supplier advance tax invoice (or its credit note) is recorded from the payment it invoices. Reject this draft and record it again." });
    }
    // 🔴 H1 — ALLOWLIST (see create). `status`/`paidAmount`/`paidAt` excluded.
    /**
     * 🔴 `documentType` and `creditNoteAgainstBillId` are deliberately NOT
     * editable. What a document IS is decided when it is entered; letting an
     * approved bill become a credit note by PATCH would flip the sign of an
     * entry that has already posted, and a draft can simply be re-entered.
     */
    const values = pick<typeof import("@workspace/db").billsTable.$inferInsert>(data, [
      "billNumber", "vendorReference", "date", "dueDate", "vendorId", "currency",
      "notes", "reviewNote", "subtotal", "vatAmount", "total", "expenseAccountId", "capitalisesAssetId",
      "supplierDocumentKind", "recordedAsExpense", "expensePaidFromBankAccountId", "expensePaidAt",
    ]);
    assertSupplierDocumentKind(values.supplierDocumentKind);
    // An expense is judged on the draft as it will STAND (a partial PATCH keeps the stored fields).
    if (values.recordedAsExpense !== undefined || values.expensePaidFromBankAccountId !== undefined || values.expensePaidAt !== undefined) {
      const merged: Record<string, any> = {
        recordedAsExpense: values.recordedAsExpense ?? existing.recordedAsExpense,
        expensePaidFromBankAccountId: values.expensePaidFromBankAccountId !== undefined ? values.expensePaidFromBankAccountId : existing.expensePaidFromBankAccountId,
        expensePaidAt: values.expensePaidAt !== undefined ? values.expensePaidAt : existing.expensePaidAt,
      };
      await normaliseExpense(merged, existing.documentType);
      Object.assign(values, merged);
    }
    if (values.expenseAccountId != null) await assertExpenseAccount(values.expenseAccountId);
    if (values.date !== undefined) {
      assertDateString(values.date, "date");
      // Owner policy (2026-08-23): a document must not be DATED into a closed
      // month by PATCH when create refuses the same date — see the full note
      // in invoices.service.update. Approval re-checks via glPosting.
      await checkPeriodOpen(values.date);
    }
    if (values.dueDate != null) assertDateString(values.dueDate, "dueDate");
    for (const f of ["subtotal", "vatAmount", "total"] as const) {
      if (values[f] != null) assertAmount(values[f], f, { min: 0, allowZero: true });
    }
    await assertVendorExists(values.vendorId);
    const [bill] = await billsRepository.update(id, values);
    // Z-AP1: the draft's advance deductions, re-checked against the bill as it now stands.
    if (data.prepayments !== undefined) {
      const rows = Array.isArray(data.prepayments) ? (data.prepayments as PrepaymentInput[]) : [];
      const prepared = await supplierAdvanceInvoicesService.preparePrepayments(rows, {
        vendorId: bill.vendorId, date: bill.date, subtotal: Number(bill.subtotal), vatAmount: Number(bill.vatAmount),
        total: Number(bill.total), documentType: bill.documentType, capitalisesAssetId: bill.capitalisesAssetId,
      });
      await supplierAdvanceInvoicesService.writePrepayments(id, prepared);
    }
    await linkEvidence(data.captureId, id);
    await vatEvidenceService.refresh(id);
    await auditService.updated("bill", id, existing, bill);
    return billsService.getById(id);
  },

  /**
   * 🔴 Phase 13A — supply (or re-check) the evidence of an UNPOSTED document:
   * attach a captured document and re-decide the verdict. The one way a held
   * draft becomes postable without being re-keyed. Draft or submitted — adding
   * evidence changes no figure, so it does not need the draft back.
   */
  async attachEvidence(
    id: number,
    body: { captureId?: string | null; supplierDocumentKind?: string | null; vendorReference?: string | null; evidenceDate?: string | null },
    userId: number | null,
  ) {
    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft" && existing.status !== "submitted") {
      return billsService.evidenceForPosted(existing, body, userId);
    }
    await linkEvidence(body.captureId, id);
    const verdict = await vatEvidenceService.refresh(id);
    await auditService.record({
      action: "evidence", entityType: "bill", entityId: id, before: { vatEvidenceStatus: existing.vatEvidenceStatus },
      after: { captureId: body.captureId ?? null, vatEvidenceStatus: verdict?.status ?? null, userId },
    });
    return billsService.getById(id);
  },

  /**
   * 🔴 X1 — evidence for a POSTED document whose input VAT is held. Only the
   * evidence facts may change (the supplier document held, its number, the
   * document itself) — never a figure: the document is in the books. The
   * attached document becomes the posted bill's immutable evidence at once.
   * When the evidence now supports the claim, the held VAT is claimed on the
   * evidence date (`vatEvidenceService.claimHeldVat`); otherwise the new
   * verdict is stored and nothing posts.
   */
  async evidenceForPosted(
    existing: typeof import("@workspace/db").billsTable.$inferSelect,
    body: { captureId?: string | null; supplierDocumentKind?: string | null; vendorReference?: string | null; evidenceDate?: string | null },
    userId: number | null,
  ) {
    if (existing.inputVatState !== "awaiting_evidence") {
      throw new ConflictError("This bill is posted and its input VAT is not held for evidence — there is no evidence left to supply.");
    }
    assertSupplierDocumentKind(body.supplierDocumentKind);
    const facts: Record<string, string | null> = {};
    if (body.supplierDocumentKind != null) facts.supplierDocumentKind = body.supplierDocumentKind;
    if (body.vendorReference != null && body.vendorReference.trim()) facts.vendorReference = body.vendorReference.trim();
    if (Object.keys(facts).length) await billsRepository.update(existing.id, facts);
    if (body.captureId != null && body.captureId !== "") await captureService.attachToBill(String(body.captureId), existing.id);
    const claim = await vatEvidenceService.claimHeldVat(existing.id, { date: body.evidenceDate ?? null, userId });
    const [after] = await billsRepository.findById(existing.id);
    await auditService.record({
      action: "evidence", entityType: "bill", entityId: existing.id,
      before: { vatEvidenceStatus: existing.vatEvidenceStatus, inputVatState: existing.inputVatState, ...(Object.keys(facts).length ? { supplierDocumentKind: existing.supplierDocumentKind, vendorReference: existing.vendorReference } : {}) },
      after: { captureId: body.captureId ?? null, ...facts, vatEvidenceStatus: after?.vatEvidenceStatus ?? null, inputVatState: after?.inputVatState ?? null, claimedOn: claim?.claimedOn ?? null, userId },
    });
    return billsService.getById(existing.id);
  },

  /** 🔴 Phase 13A — the verdict for figures not yet saved (the review page, the bill form). */
  evidencePreview(body: Parameters<typeof vatEvidenceService.preview>[0]) {
    return vatEvidenceService.preview(body);
  },

  /** 🔴 Phase 13A — possible duplicates of a document being entered. WARN, never refuse. */
  async duplicates(q: Parameters<typeof duplicatesService.forBill>[0]) {
    return { items: await duplicatesService.forBill(q) };
  },

  /** 🔴 Phase 13A — every unposted document held for VAT evidence, and why. */
  async heldForEvidence(filter: { reason?: string; q?: string; limit: number; offset: number }) {
    const [rows, meta] = await Promise.all([billsRepository.heldForEvidence(filter), billsRepository.heldMeta(filter)]);
    return {
      items: rows.map((r) => buildBillOut(r.bill, r.vendor, undefined, null, null)),
      page: { limit: filter.limit, offset: filter.offset, total: meta.total },
      totals: { heldVat: meta.heldVat, byStatus: meta.byStatus, byReason: meta.byReason },
    };
  },

  /**
   * Record a payment against an approved bill — the one bill-payment path
   * (`bills.payment.ts`), then read the bill back through the one definition,
   * so the response carries what it owes NOW.
   */
  async pay(id: number, body: { amount: unknown; paidAt?: string; bankAccountId?: unknown; whtPaymentType?: unknown; whtNotSubjectReason?: unknown; whtNotSubjectNote?: unknown }, userId: number | null) {
    await payBill(id, body, userId);
    return billsService.getById(id);
  },

  /** B4 — the payment history, newest first. Backfilled rows are aggregates. */
  async payments(id: number) {
    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    const rows = await paymentsRepository.listForBill(id);
    // Phase 16: what each payment withheld (one read for the whole list, never per row)
    const wht = new Map((await taxRepository.withholdingsForBillPayments(rows.map((p) => p.id))).map((w) => [w.billPaymentId, w]));
    return rows.map((p) => {
      const w = wht.get(p.id);
      return {
        id: p.id,
        amount: Number(p.amount),
        paidAt: p.paidAt,
        backfilled: p.backfilled,
        // D-4 covers customer payments only in Batch 1B Part 1; a bill payment is still the B4 row.
        paymentId: null as number | null,
        withheld: w ? Number(w.whtAmount) : null,
        cashPaid: w ? round2(Number(p.amount) - Number(w.whtAmount)) : null,
        whtPaymentType: w?.paymentType ?? null,
      };
    });
  },

  /**
   * 🔴 Named `deleteDraft`, not `remove`, because that is what it does.
   *
   * The route is `DELETE /<resource>/:id` — correct, it addresses the resource —
   * but the verb implies a delete that mostly is NOT one: an issued invoice
   * cannot be deleted at all, and the refusal ("Issued invoices must be
   * reversed with a credit note") is the normal case rather than the edge. A
   * service method called `remove` invites a caller to believe otherwise. The
   * name now states the precondition the body enforces, so a reader sees it
   * before reaching the guard.
   */
  async deleteDraft(id: number) {
    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") throw new ConflictError("Only draft bills can be deleted.");
    await billsRepository.remove(id);
    await auditService.deleted("bill", id, existing);
  },
};
