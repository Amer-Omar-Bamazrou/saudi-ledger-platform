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
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from "../lib/errors";
import { pick, assertAmount, assertRate, assertDateString } from "../lib/writeGuards";
import { vendorsRepository } from "../repositories/vendors.repository";

/**
 * MED (audit 2026-08-20): the vendor twin of invoices' assertCustomerExists —
 * a nonexistent vendorId was a raw FK 500, and the RLS-blind FK check accepted
 * another tenant's vendor id. Tenant-scoped lookup; 422 (semantically invalid
 * input that passed schema validation — status policy, 2026-08-23).
 */
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
import { checkPeriodOpen } from "./accounting/periodLock";
import { approvalService } from "./approval";
import { billApprovable, type BillApproveOptions } from "./bills.approvable";
import { buildBillOut } from "./bills.presenter";
import { billsRepository, type BillListFilter } from "../repositories/bills.repository";
import { paymentsRepository } from "../repositories/payments.repository";

export const billsService = {
  async list(filter: BillListFilter) {
    const rows = await billsRepository.list(filter);
    return rows.map((r) => buildBillOut(r.bill, r.vendor));
  },

  async getById(id: number) {
    const [row] = await billsRepository.findWithVendor(id);
    if (!row) throw new NotFoundError("Not found");
    const items = await billsRepository.itemsByBill(id);
    return buildBillOut(row.bill, row.vendor, items);
  },

  async create(body: Record<string, any>, userId: number | null) {
    const { items = [] } = body;
    // 🔴 H1 — ALLOWLIST. `status` is forced to "draft" below; `paidAmount`/
    // `paidAt` are set by the pay path; a client sets only header fields (and,
    // for a no-items bill, the totals — validated ≥ 0). The raw spread let a
    // draft be created pre-"approved", payable against an AP balance never
    // posted (a permanent GL imbalance through the pay path).
    const billData = pick<Record<string, unknown>>(body, [
      "billNumber", "vendorReference", "date", "dueDate", "vendorId", "currency",
      "notes", "reviewNote", "subtotal", "vatAmount", "total",
    ]) as Record<string, any>;
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
    const round2 = (n: number) => Math.round(n * 100) / 100;
    let subtotal = 0;
    let vatTotal = 0;
    const preparedItems = items.map((it: any) => {
      const base = round2(Number(it.quantity) * Number(it.unitPrice));
      const vat = round2(base * (Number(it.vatRate ?? 15) / 100));
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

    await checkPeriodOpen(billData.date ?? new Date().toISOString().split("T")[0]);
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
    // 🔴 H1 — ALLOWLIST (see create). `status`/`paidAmount`/`paidAt` excluded.
    const values = pick<typeof import("@workspace/db").billsTable.$inferInsert>(data, [
      "billNumber", "vendorReference", "date", "dueDate", "vendorId", "currency",
      "notes", "reviewNote", "subtotal", "vatAmount", "total",
    ]);
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
    await auditService.updated("bill", id, existing, bill);
    return buildBillOut(bill, null);
  },

  async pay(id: number, body: { amount: unknown; paidAt?: string }, userId: number | null) {
    const { amount, paidAt } = body;

    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");

    // A bill must be approved (posted to AP) before it can be paid — a draft or
    // queued bill has no payable AP balance yet.
    if (existing.status === "draft" || existing.status === "submitted") {
      throw new ConflictError("Bill must be approved before it can be paid.");
    }
    if (existing.status === "paid") throw new ConflictError("Bill is already paid.");

    // Validate the amount up front — a missing/non-numeric amount previously
    // reached the numeric column and surfaced as an unhandled 500.
    const paid = Number(amount);
    if (!Number.isFinite(paid) || paid <= 0) {
      throw new BadRequestError("A positive payment amount is required.");
    }

    // M16.3: payments accumulate; a partial keeps the bill open (it must stay
    // in AP aging); overpay is refused. Mirrors invoices.service.pay — see the
    // note there.
    const alreadyPaid = Number(existing.paidAmount ?? 0);
    const outstanding = Math.round((Number(existing.total) - alreadyPaid) * 100) / 100;
    if (paid > outstanding + 0.005) {
      throw new ConflictError(
        `Payment of ${paid.toFixed(2)} exceeds the outstanding balance of ${outstanding.toFixed(2)} on this bill.`,
      );
    }
    const newPaid = Math.round((alreadyPaid + paid) * 100) / 100;
    const fullySettled = outstanding - paid < 0.01;

    const payDate = paidAt ?? new Date().toISOString().split("T")[0];
    const [bill] = await billsRepository.update(id, {
      paidAmount: String(newPaid),
      paidAt: payDate,
      status: fullySettled ? "paid" : existing.status,
    });

    // ── GL: Dr Accounts Payable / Cr Cash and Bank ──
    await postJournalEntry({
      entryNumber: `BILL-${bill.billNumber}-PAY`,
      date: payDate,
      description: `Payment to vendor for bill ${bill.billNumber}`,
      reference: bill.billNumber ?? undefined,
      lines: [
        { systemCode: "AP", accountName: "Accounts Payable", description: `Payment for ${bill.billNumber}`, debitAmount: paid, creditAmount: 0 },
        { systemCode: "CASH", accountName: "Cash and Bank", description: `Payment for ${bill.billNumber}`, debitAmount: 0, creditAmount: paid },
      ],
    });

    // B4 — the dated record of THIS payment (see invoices.service.pay).
    await paymentsRepository.recordBillPayment(id, paid, payDate);

    await auditService.record({ action: "pay", entityType: "bill", entityId: id, before: existing, after: bill });
    return buildBillOut(bill, null);
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
    }));
  },

  async remove(id: number) {
    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") throw new ConflictError("Only draft bills can be deleted.");
    await billsRepository.remove(id);
    await auditService.deleted("bill", id, existing);
  },
};
