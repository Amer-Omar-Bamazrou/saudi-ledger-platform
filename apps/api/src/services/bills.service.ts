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
import { buildBillOut } from "./bills.presenter";
import { billsRepository, DEFAULT_PAGE as BILL_PAGE, type BillListFilter } from "../repositories/bills.repository";
import { paymentsRepository } from "../repositories/payments.repository";
import { round2 } from "../lib/money";
import { businessToday } from "@workspace/shared";
import { supplierAdvanceInvoicesService, type PrepaymentInput } from "./accounting/supplierAdvanceInvoices.service";


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
    return buildBillOut(row.bill, row.vendor, items, row.outstanding, row.prepaid, prepayments);
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
    ]) as Record<string, any>;
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

    await auditService.created("bill", bill.id, bill);
    return buildBillOut(bill, null);
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
    ]);
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
    await auditService.updated("bill", id, existing, bill);
    return buildBillOut(bill, null);
  },

  async pay(id: number, body: { amount: unknown; paidAt?: string; bankAccountId?: unknown }, userId: number | null) {
    const { amount, paidAt } = body;

    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");

    // A bill must be approved (posted to AP) before it can be paid — a draft or
    // queued bill has no payable AP balance yet.
    if (existing.status === "draft" || existing.status === "submitted") {
      throw new ConflictError("Bill must be approved before it can be paid.");
    }
    if (existing.status === "paid") throw new ConflictError("Bill is already paid.");
    /**
     * 🔴 B7 — A CREDIT NOTE IS NOT PAYABLE. It is money the supplier owes US,
     * and a posted note's status is `received` like any other posted purchase
     * document, so without this the pay path would happily post Dr AP / Cr
     * cash against it: paying a document that reduces what we owe. The note's
     * balance leaves by being APPLIED to a bill, or by a refund.
     *
     * A DEBIT note is payable — it is an additional charge.
     */
    if (existing.documentType === "advance_invoice" || existing.documentType === "advance_credit_note") {
      throw new ConflictError(`${existing.billNumber} is a supplier ADVANCE document — the advance was paid before it existed, so there is nothing to pay. It is deducted by the supplier's final bill.`);
    }
    if (existing.documentType === "credit_note") {
      throw new ConflictError(
        `${existing.billNumber} is a supplier CREDIT note — it reduces what you owe, so it is not paid. Apply it to a bill instead.`,
      );
    }
    assertNotReversedOpening(existing, `Bill ${existing.billNumber}`, "paid");

    // Validate the amount up front — a missing/non-numeric amount previously
    // reached the numeric column and surfaced as an unhandled 500.
    const paid = Number(amount);
    if (!Number.isFinite(paid) || paid <= 0) {
      throw new BadRequestError("A positive payment amount is required.");
    }
    // 🔴 D-3 (2026-09-16): WHICH bank did the money move through? Checked at
    // the same boundary as the amount — before any balance arithmetic and
    // before any write — with the one shared rule (accounting/bankIdentity).
    const bankAccountId = await assertBankAccount(body.bankAccountId, { what: "the payment left from" });

    // M16.3: payments accumulate; a partial keeps the bill open (it must stay
    // in AP aging); overpay is refused. Mirrors invoices.service.pay — see the
    // note there.
    //
    // 🔴 Phase 11 Part 2: what the bill still owes is `billPosition`'s
    // definition, read under a row lock — NOT `total − paid_amount`. Money now
    // also reaches a bill through the AP subledger (a supplier payment, an
    // applied advance, an applied credit note); reading the legacy counter
    // alone accepted a full payment on a bill an advance had already settled,
    // and posted Dr AP twice for one debt.
    const alreadyPaid = Number(existing.paidAmount ?? 0);
    const outstanding = await billsRepository.outstandingOf(id, { lock: true });
    if (paid > outstanding + 0.005) {
      throw new ConflictError(
        `Payment of ${paid.toFixed(2)} exceeds the outstanding balance of ${outstanding.toFixed(2)} on this bill.`,
      );
    }
    const newPaid = Math.round((alreadyPaid + paid) * 100) / 100;
    const fullySettled = outstanding - paid < 0.01;

    const payDate = paidAt ?? businessToday();
    const [bill] = await billsRepository.update(id, {
      paidAmount: String(newPaid),
      paidAt: payDate,
      status: fullySettled ? "paid" : existing.status,
    });

    // B4 — the dated record of THIS payment (see invoices.service.pay).
    // 🔴 N3: recorded BEFORE the GL entry so its id makes the entry number
    // unique — `BILL-x-PAY` alone collided on the second partial payment.
    const payment = await paymentsRepository.recordBillPayment(id, paid, payDate, bankAccountId);

    // ── GL: Dr Accounts Payable / Cr <the bank's own cash account> ──
    const payEntry = await postJournalEntry({
      entryNumber: `BILL-${bill.billNumber}-PAY-${payment.id}`,
      date: payDate,
      description: `Payment to vendor for bill ${bill.billNumber}`,
      reference: bill.billNumber ?? undefined,
      lines: [
        { systemCode: "AP", accountName: "Accounts Payable", description: `Payment for ${bill.billNumber}`, debitAmount: paid, creditAmount: 0, party: bill.vendorId != null ? { type: "vendor" as const, vendorId: bill.vendorId } : { type: "none" as const, reason: "bill with no vendor record" } },
        { bankAccountId, description: `Payment for ${bill.billNumber}`, debitAmount: 0, creditAmount: paid },
      ],
    });

    // Phase 12B: the payment names its entry, so its cash line can be reconciled to the bank's statement line.
    await paymentsRepository.setBillPaymentEntry(payment.id, payEntry.id);
    await auditService.record({ action: "pay", entityType: "bill", entityId: id, before: existing, after: bill });
    // Read back through the one definition, so the response carries what the
    // bill owes NOW rather than a null the pay dialog would have to guess past.
    return billsService.getById(id);
  },

  /** B4 — the payment history, newest first. Backfilled rows are aggregates. */
  async payments(id: number) {
    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    return (await paymentsRepository.listForBill(id)).map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      paidAt: p.paidAt,
      backfilled: p.backfilled,
      // D-4 covers customer payments only in Batch 1B Part 1; a bill payment is still the B4 row.
      paymentId: null as number | null,
    }));
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
