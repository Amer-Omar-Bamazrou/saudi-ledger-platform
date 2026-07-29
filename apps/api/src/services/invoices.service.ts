/**
 * Invoices service — the draft/approval workflow (M10.4).
 *
 * The single most important correctness property: **the ZATCA hash chain and
 * the AR GL posting are deferred to approval** (`invoiceApprovable().onApprove`),
 * NOT done at create. A draft/submitted invoice carries a null `invoice_hash`,
 * so it consumes no sequence number and a rejected/deleted draft never leaves a
 * gap in the legally-required chain.
 *
 * `create` therefore only computes totals and persists a DRAFT. An approver
 * (admin/accountant) **self-approves on create** — the controller passes
 * `autoApprove` (from the RBAC matrix), so their invoices post + hash + issue
 * immediately in one call, exactly as before M10. A bookkeeper's create stays a
 * draft awaiting approval.
 *
 * The draft→submitted→approved transitions and the on-approve activation are the
 * generic {@link approvalService} + {@link invoiceApprovable} adapter — the same
 * engine journal entries and bills use.
 */
import { ConflictError, NotFoundError, BadRequestError } from "../lib/errors";
import { auditService } from "./audit.service";
import { postJournalEntry } from "./accounting/glPosting";
import { checkPeriodOpen } from "./accounting/periodLock";
import { approvalService } from "./approval";
import { invoiceApprovable } from "./invoices.approvable";
import { buildInvoiceOut } from "./invoices.presenter";
import { invoicesRepository, type InvoiceListFilter } from "../repositories/invoices.repository";

const DEFAULT_SELLER_VAT = "300000000000003";
const DEFAULT_SELLER_NAME = "KSA Ledger Company";

export const invoicesService = {
  async list(filter: InvoiceListFilter) {
    const rows = await invoicesRepository.list(filter);
    return rows.map((r) => buildInvoiceOut(r.inv, r.cust));
  },

  async getById(id: number) {
    const [row] = await invoicesRepository.findWithCustomer(id);
    if (!row) throw new NotFoundError("Not found");
    const items = await invoicesRepository.itemsByInvoice(id);
    return buildInvoiceOut(row.inv, row.cust, items);
  },

  /**
   * Create an invoice as a DRAFT (no hash, no QR, no GL). When `autoApprove` is
   * set (caller may approve — admin/accountant), immediately approve it so it is
   * issued in one call, preserving pre-M10 behavior for approvers.
   */
  async create(body: Record<string, any>, userId: number | null, opts: { autoApprove?: boolean } = {}) {
    const { items = [], ...invData } = body;
    let subtotal = 0;
    let vatTotal = 0;
    const preparedItems = items.map((it: any) => {
      const lineTotal = Number(it.quantity) * Number(it.unitPrice);
      const disc = Number(it.discount ?? 0);
      const base = lineTotal - disc;
      const vat = base * (Number(it.vatRate ?? 15) / 100);
      subtotal += base;
      vatTotal += vat;
      return {
        ...it,
        quantity: String(it.quantity),
        unitPrice: String(it.unitPrice),
        vatAmount: String(vat.toFixed(2)),
        total: String((base + vat).toFixed(2)),
      };
    });
    const total = subtotal + vatTotal - Number(invData.discount ?? 0);

    // A draft dated in a closed period is harmless (no ledger effect), but keep
    // the early guard so drafts aren't entered into closed periods.
    await checkPeriodOpen(invData.date ?? new Date().toISOString().split("T")[0]);

    // Persist a DRAFT — deliberately NO invoiceHash/previousHash/qrCode and NO GL
    // posting here; those are minted only at approval. Seller identity is
    // captured now (denormalized for the QR built at approval).
    const [inv] = await invoicesRepository.insert({
      ...invData,
      subtotal: String(subtotal.toFixed(2)),
      vatAmount: String(vatTotal.toFixed(2)),
      total: String(total.toFixed(2)),
      status: "draft",
      createdBy: userId ?? null,
      sellerName: invData.sellerName ?? DEFAULT_SELLER_NAME,
      sellerVatNumber: invData.sellerVatNumber ?? DEFAULT_SELLER_VAT,
    } as Parameters<typeof invoicesRepository.insert>[0]);

    if (preparedItems.length > 0) {
      await invoicesRepository.insertItems(preparedItems.map((it: any) => ({ ...it, invoiceId: inv.id })));
    }

    await auditService.created("invoice", inv.id, inv);

    // Self-approve on create for approvers → issue immediately (hash + QR + GL).
    if (opts.autoApprove) {
      return this.approve(inv.id, userId);
    }
    return buildInvoiceOut(inv, null);
  },

  /** Submit a draft invoice into the approval queue (bookkeeper action). */
  submit(id: number, userId: number | null) {
    return approvalService.submit(invoiceApprovable(), id, { userId: userId ?? null });
  },

  /** Send a submitted invoice back to the enterer for correction (approver action). */
  sendBack(id: number, note: string | undefined, userId: number | null) {
    return approvalService.sendBack(invoiceApprovable(), id, { userId: userId ?? null }, note);
  },

  /** Reject (hard-delete) a non-approved invoice (approver action). */
  reject(id: number, userId: number | null) {
    return approvalService.reject(invoiceApprovable(), id, { userId: userId ?? null });
  },

  /** Approve an invoice — issues it (hash chain + QR + AR GL posting). */
  approve(id: number, userId: number | null) {
    return approvalService.approve(invoiceApprovable(), id, { userId: userId ?? null });
  },

  async update(id: number, data: Record<string, unknown>) {
    const [existing] = await invoicesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") {
      throw new ConflictError("Only draft invoices can be edited. Use a credit note to correct an issued invoice.");
    }
    const [inv] = await invoicesRepository.update(id, data);
    await auditService.updated("invoice", id, existing, inv);
    return buildInvoiceOut(inv, null);
  },

  async pay(id: number, body: { amount: unknown; paidAt?: string }, userId: number | null) {
    const { amount, paidAt } = body;

    const [existing] = await invoicesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");

    // Only an issued (approved) invoice has a receivable to settle.
    if (existing.status === "draft" || existing.status === "submitted") {
      throw new ConflictError("Invoice must be approved before a payment can be recorded.");
    }
    if (existing.status === "paid") throw new ConflictError("Invoice is already paid.");

    // Validate up front — a missing/non-numeric amount previously reached the
    // numeric column and surfaced as an unhandled 500.
    const paid = Number(amount);
    if (!Number.isFinite(paid) || paid <= 0) {
      throw new BadRequestError("A positive payment amount is required.");
    }

    const payDate = paidAt ?? new Date().toISOString().split("T")[0];
    const [inv] = await invoicesRepository.update(id, {
      paidAmount: String(paid),
      paidAt: payDate,
      status: "paid",
    });

    // ── GL: Dr Cash and Bank / Cr Accounts Receivable ──
    await postJournalEntry({
      entryNumber: `GL-${inv.invoiceNumber}-PAY`,
      date: payDate,
      description: `Payment received for invoice ${inv.invoiceNumber}`,
      reference: inv.invoiceNumber,
      lines: [
        { accountName: "Cash and Bank", description: `Receipt for ${inv.invoiceNumber}`, debitAmount: paid, creditAmount: 0 },
        { accountName: "Accounts Receivable", description: `Receipt for ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: paid },
      ],
    });

    await auditService.record({ action: "pay", entityType: "invoice", entityId: id, before: existing, after: inv });
    return buildInvoiceOut(inv, null);
  },

  async remove(id: number) {
    const [existing] = await invoicesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") {
      throw new ConflictError("Only draft invoices can be deleted. Issued invoices must be reversed with a credit note.");
    }
    await invoicesRepository.remove(id);
    await auditService.deleted("invoice", id, existing);
  },
};
