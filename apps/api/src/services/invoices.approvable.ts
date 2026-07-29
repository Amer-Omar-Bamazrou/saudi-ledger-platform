/**
 * Invoice approval adapter — plugs invoices into the generic {@link approvalService}
 * (M10.4). Invoices exercise the full state machine (draft → submitted →
 * approved) with send-back, and carry the highest-risk correctness property in
 * all of M10:
 *
 *   ── The ZATCA hash chain is built ONLY at approval ──────────────────────────
 *   A draft/submitted invoice has `invoice_hash = NULL`. {@link getPreviousInvoiceHash}
 *   only ever looks at invoices with a non-null hash, so drafts are invisible to
 *   the chain and consume NO sequence number. A rejected or deleted draft
 *   therefore leaves no gap in the legally-required sequence. The link is minted
 *   inside `onApprove`, atomically with the AR GL posting, within the request's
 *   tenant transaction — so an approval that fails (e.g. locked period) rolls
 *   back the hash assignment too, and the next approval reuses the same
 *   previous-hash. This defers to approval what the pre-M10 create did eagerly.
 *
 * State mapping (spec §9, §10):
 *   draft     → draft      (editable; not in AR/VAT; NOT in the hash chain)
 *   submitted → submitted  (locked, awaiting approval; still not in the books)
 *   sent      → approved   (issued: hashed, QR, AR/revenue/VAT posted)
 *   paid      → approved   (post-approval)
 *   overdue   → approved   (post-approval)
 */
import { db, invoicesTable } from "@workspace/db";
import { postJournalEntry } from "./accounting/glPosting";
import { checkPeriodOpen } from "./accounting/periodLock";
import { generateZatcaQr, computeInvoiceHash, getPreviousInvoiceHash } from "./accounting/zatca";
import { invoicesRepository } from "../repositories/invoices.repository";
import { buildInvoiceOut, toNum, type InvoiceOut } from "./invoices.presenter";
import type { Approvable, ApprovalState } from "./approval";
import type { invoicesTable as InvoicesTable, customersTable } from "@workspace/db";

type Invoice = typeof InvoicesTable.$inferSelect;
type Customer = typeof customersTable.$inferSelect;
type InvoiceRow = { inv: Invoice; cust: Customer | null };

const DEFAULT_SELLER_VAT = "300000000000003";
const DEFAULT_SELLER_NAME = "KSA Ledger Company";

/**
 * The invoice's on-approve action — the ledger-affecting + e-invoice-issuing
 * moment, deferred here from create. Mints the hash-chain link, the QR, and the
 * AR GL posting. Runs only on a transition into `approved`.
 */
async function issueInvoice(row: InvoiceRow): Promise<InvoiceOut> {
  const inv = row.inv;

  // Approval is when it hits the books — enforce the period lock first.
  await checkPeriodOpen(inv.date);

  const subtotal = toNum(inv.subtotal);
  const vatAmount = toNum(inv.vatAmount);
  const total = toNum(inv.total);

  const sellerVatNumber = inv.sellerVatNumber ?? DEFAULT_SELLER_VAT;
  const sellerName = inv.sellerName ?? DEFAULT_SELLER_NAME;
  const invoiceDateTime = `${inv.date}T00:00:00Z`;

  // ── ZATCA hash chain + QR — the sequence number is consumed HERE, not at
  //    create. getPreviousInvoiceHash ignores null-hash (draft) invoices. ──
  const previousHash = await getPreviousInvoiceHash(db, invoicesTable);
  const invoiceHash = computeInvoiceHash({
    invoiceNumber: inv.invoiceNumber,
    date: inv.date,
    sellerVatNumber,
    total: total.toFixed(2),
    vatAmount: vatAmount.toFixed(2),
    previousHash,
  });
  const qrCode = generateZatcaQr({
    sellerName,
    vatNumber: sellerVatNumber,
    invoiceDateTime,
    totalWithVat: total.toFixed(2),
    vatAmount: vatAmount.toFixed(2),
  });

  const [updated] = await invoicesRepository.update(inv.id, {
    status: "sent",
    invoiceHash,
    previousHash,
    qrCode,
    sellerName,
    sellerVatNumber,
    reviewNote: null,
  });

  // ── GL: Dr Accounts Receivable / Cr Sales Revenue + VAT Payable ──
  if (total > 0) {
    await postJournalEntry({
      entryNumber: `GL-${inv.invoiceNumber}`,
      date: inv.date,
      description: `Customer invoice ${inv.invoiceNumber}`,
      reference: inv.invoiceNumber,
      lines: [
        { accountName: "Accounts Receivable", description: `Invoice ${inv.invoiceNumber}`, debitAmount: total, creditAmount: 0 },
        { accountName: "Sales Revenue", description: `Invoice ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: subtotal },
        { accountName: "VAT Payable", description: `VAT on invoice ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: vatAmount },
      ],
    });
  }

  return buildInvoiceOut(updated, row.cust);
}

/** Build the invoice approval adapter for one request. */
export function invoiceApprovable(): Approvable<InvoiceRow, InvoiceOut> {
  return {
    entityType: "invoice",

    async load(id) {
      const [row] = await invoicesRepository.findWithCustomer(id);
      return row ?? null;
    },

    state(row): ApprovalState {
      if (row.inv.status === "draft") return "draft";
      if (row.inv.status === "submitted") return "submitted";
      return "approved";
    },

    async snapshot(row) {
      const items = await invoicesRepository.itemsByInvoice(row.inv.id);
      return buildInvoiceOut(row.inv, row.cust, items);
    },

    onApprove(row) {
      return issueInvoice(row);
    },

    async onSubmit(row) {
      const [updated] = await invoicesRepository.update(row.inv.id, { status: "submitted", reviewNote: null });
      return buildInvoiceOut(updated, row.cust);
    },

    async onSendBack(row, _actor, note) {
      const [updated] = await invoicesRepository.update(row.inv.id, {
        status: "draft",
        reviewNote: note?.trim() ? note.trim() : null,
      });
      return buildInvoiceOut(updated, row.cust);
    },

    async hardDelete(row) {
      await invoicesRepository.remove(row.inv.id);
    },
  };
}
