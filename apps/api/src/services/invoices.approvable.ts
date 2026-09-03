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
import { randomUUID } from "node:crypto";
import { postJournalEntry } from "./accounting/glPosting";
import { checkPeriodOpen } from "./accounting/periodLock";
import { generateZatcaQr, computeInvoiceHash, LEGACY_GENESIS_HASH } from "./accounting/zatca";
import { invoicesRepository } from "../repositories/invoices.repository";
import { assertNoteIsValid, isNoteType } from "./creditNotes";
import { requireIssuanceSeller } from "./sellerIdentity";
import { enqueueEInvoice } from "./einvoice/outbox/enqueue";
import { BusinessRuleError } from "../lib/errors";
import { logger } from "../lib/logger";
import { buildInvoiceOut, toNum, type InvoiceOut } from "./invoices.presenter";
import type { Approvable, ApprovalState } from "./approval";
import type { invoicesTable as InvoicesTable, customersTable } from "@workspace/db";

type Invoice = typeof InvoicesTable.$inferSelect;
type Customer = typeof customersTable.$inferSelect;
type InvoiceRow = { inv: Invoice; cust: Customer | null };

// Seller identity is resolved from the ACTIVE COMPANY via sellerIdentity.ts.
// The former DEFAULT_SELLER_VAT / DEFAULT_SELLER_NAME constants (a ZATCA SANDBOX
// placeholder, duplicated here and in invoices.service.ts) are gone — see that
// module for why there is deliberately no fallback value any more.

/** Human label per document type — used in the GL entry description. */
const DOCUMENT_LABEL: Record<string, string> = {
  invoice: "Customer invoice",
  credit_note: "Credit note",
  debit_note: "Debit note",
};

/**
 * The invoice's on-approve action — the ledger-affecting + e-invoice-issuing
 * moment, deferred here from create. Mints the hash-chain link, the ICV/UUID,
 * the QR, and the GL posting. Runs only on a transition into `approved`.
 *
 * Serves invoices AND notes: they are the same row shape and share one chain,
 * one ICV sequence and one approval workflow. Only the GL direction differs.
 */
async function issueInvoice(row: InvoiceRow): Promise<InvoiceOut> {
  const inv = row.inv;

  // Approval is when it hits the books — enforce the period lock first.
  await checkPeriodOpen(inv.date);

  // Re-validate a note at APPROVAL, not only at create (M12.1b). The state can
  // change while it sits in the queue: a concurrent note may have consumed the
  // remaining credit, or the original may have been corrected. `excludeNoteId`
  // stops this note counting against itself on the second pass.
  if (isNoteType(inv.documentType)) {
    await assertNoteIsValid({
      documentType: inv.documentType,
      originalInvoiceId: inv.originalInvoiceId,
      noteReason: inv.noteReason,
      total: toNum(inv.total),
      excludeNoteId: inv.id,
    });
  }

  const subtotal = toNum(inv.subtotal);
  const vatAmount = toNum(inv.vatAmount);
  const total = toNum(inv.total);

  // The tenant's real ZATCA identity — fails closed if unconfigured, so an
  // invoice can never be issued carrying a placeholder VAT number.
  // M12.1a: resolved from THIS INVOICE'S company, not "the first company in the
  // org" — otherwise a multi-company org stamps the wrong legal entity.
  const { sellerName, sellerVatNumber } = await requireIssuanceSeller(inv.companyId, {
    sellerName: inv.sellerName,
    sellerVatNumber: inv.sellerVatNumber,
  });

  // M12.1a: the real issuance instant. `inv.date` is the ACCOUNTING date (what
  // the ledger and reports use); ZATCA needs date+time and the 24-hour
  // simplified-reporting clock runs off this. Previously a fabricated
  // `T00:00:00Z` was fed into the QR.
  const issuedAt = new Date();
  const invoiceDateTime = issuedAt.toISOString().replace(/\.\d{3}Z$/, "Z");

  // ── Hash chain + ICV — the sequence position is consumed HERE, not at create.
  //    Scoped to THIS COMPANY (M12.1a): the chain is per EGS unit, so a
  //    multi-company org must not interleave. Drafts carry a null hash and are
  //    excluded, so they still consume no sequence number.
  //
  //    🔴 SERIALISED per company (M12.1b). Reading the chain head and the ICV
  //    max are both read-then-write; two concurrent approvals under READ
  //    COMMITTED would otherwise read the same head, duplicating the ICV and
  //    FORKING THE CHAIN. The unique index catches the duplicate but cannot
  //    unfork the chain, so the lock is the mechanism and the index the
  //    backstop. Transaction-scoped: released on commit or rollback. ──
  await invoicesRepository.lockCompanySequence(inv.companyId);

  const previousHash =
    (await invoicesRepository.previousInvoiceHash(inv.companyId)) ?? LEGACY_GENESIS_HASH;

  // ICV + UUID are assigned HERE (M12.1b). Before this they were never written
  // at runtime, so every issued invoice carried NULLs and the whole ZATCA
  // Phase-2 pipeline was unreachable from real data — the assembler rejects a
  // row without them. See CLAUDE.md.
  const icv = inv.icv ?? (await invoicesRepository.nextIcv(inv.companyId));
  const zatcaUuid = inv.zatcaUuid ?? randomUUID();
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

  let [updated] = await invoicesRepository.update(inv.id, {
    status: "sent",
    invoiceHash,
    previousHash,
    qrCode,
    sellerName,
    sellerVatNumber,
    issuedAt,
    icv,
    zatcaUuid,
    reviewNote: null,
  });

  // ── ZATCA Phase 2 (M12.8) ─────────────────────────────────────────────────
  // Build, sign and queue the UBL document — STILL INSIDE the sequence lock and
  // the request transaction, so the queued row commits atomically with the
  // ledger effect and the chain head cannot be read by anyone else in between.
  //
  // A company with no active credential is skipped and issuance proceeds
  // unchanged; an onboarded company that cannot produce a document throws and
  // rolls the approval back. See `enqueueEInvoice` for why those differ.
  //
  // 🔴 C5 — FAIL CLOSED, BUT SAY WHY. The rollback is deliberate (an ICV gap
  // is unrecoverable, a refused issuance is not), but until now the failure
  // reached the user as a bare 500 "Internal server error": no field, no
  // company, nothing to act on. The posture is unchanged — the diagnosis is
  // not. `BusinessRuleError` carries a machine-readable code plus the
  // underlying reason, so the person who must fix the data (a missing buyer
  // address, a NULL tax category) can see what to fix, and a KMS outage is
  // distinguishable from bad data.
  let queued: Awaited<ReturnType<typeof enqueueEInvoice>>;
  try {
    queued = await enqueueEInvoice({
      id: inv.id,
      organizationId: inv.organizationId,
      companyId: inv.companyId,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, invoiceId: inv.id, companyId: inv.companyId },
      "🔴 issuance BLOCKED: the ZATCA document could not be built or signed — approval rolled back",
    );
    throw new BusinessRuleError(422, {
      code: "einvoice_issuance_blocked",
      error:
        `This invoice could not be issued because its ZATCA e-invoice could not be prepared, ` +
        `so nothing was posted and the invoice remains a draft. Reason: ${reason}`,
      invoiceId: inv.id,
      companyId: inv.companyId,
      // Names the two families a user can act on differently: fix the document,
      // or wait/escalate because signing infrastructure is unavailable.
      likelyCause: /credential|kms|key|sign/i.test(reason)
        ? "signing_unavailable"
        : "invoice_data_incomplete",
    });
  }

  // 🔴 An onboarded company's printed document must carry the PHASE 2 QR.
  // `generateZatcaQr` above emits tags 1–5 (Phase 1); a Phase-2 taxpayer's
  // simplified invoice must show tags 1–9, including the signature and the
  // certificate's public key. Overwriting here keeps ONE QR on the invoice —
  // the compliant one — rather than leaving the printed copy silently a
  // generation behind. Companies that are not onboarded keep the Phase-1 QR.
  if (queued.qrCode) {
    [updated] = await invoicesRepository.update(inv.id, { qrCode: queued.qrCode });
  }

  // ── GL ────────────────────────────────────────────────────────────────────
  // A CREDIT note reverses; a DEBIT note does not.
  //
  // 🔴 This is the correctness point of M12.1b. A credit note reduces what the
  // customer owes, so it reverses: Dr Sales + Dr VAT / Cr AR. A DEBIT note is an
  // ADDITIONAL CHARGE (undercharge, price correction upward, extra freight), so
  // it posts in the SAME direction as an invoice. Treating both as "reversed"
  // would understate AR and output VAT.
  //
  // Amounts are stored POSITIVE on both; direction lives in `document_type`.
  if (total > 0) {
    const isCredit = inv.documentType === "credit_note";
    const label = DOCUMENT_LABEL[inv.documentType] ?? "Invoice";

    await postJournalEntry({
      entryNumber: `GL-${inv.invoiceNumber}`,
      date: inv.date,
      description: `${label} ${inv.invoiceNumber}`,
      reference: inv.invoiceNumber,
      lines: isCredit
        ? [
            // Reversed: the receivable falls, revenue and output VAT are undone.
            { systemCode: "SALES", accountName: "Sales Revenue", description: `${label} ${inv.invoiceNumber}`, debitAmount: subtotal, creditAmount: 0 },
            { systemCode: "VAT_OUTPUT", accountName: "VAT Payable", description: `VAT on ${label.toLowerCase()} ${inv.invoiceNumber}`, debitAmount: vatAmount, creditAmount: 0 },
            { systemCode: "AR", accountName: "Accounts Receivable", description: `${label} ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: total, party: inv.customerId != null ? { type: "customer" as const, customerId: inv.customerId } : { type: "none" as const, reason: "simplified/B2C invoice — no identified customer" } },
          ]
        : [
            { systemCode: "AR", accountName: "Accounts Receivable", description: `${label} ${inv.invoiceNumber}`, debitAmount: total, creditAmount: 0, party: inv.customerId != null ? { type: "customer" as const, customerId: inv.customerId } : { type: "none" as const, reason: "simplified/B2C invoice — no identified customer" } },
            { systemCode: "SALES", accountName: "Sales Revenue", description: `${label} ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: subtotal },
            { systemCode: "VAT_OUTPUT", accountName: "VAT Payable", description: `VAT on ${label.toLowerCase()} ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: vatAmount },
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
