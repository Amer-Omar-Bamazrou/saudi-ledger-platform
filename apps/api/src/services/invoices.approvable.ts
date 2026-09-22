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
import { paymentsRepository, invoiceSettlementRepository } from "../repositories/payments.repository";
import { CUSTOMER_CREDIT_ACCOUNT, CUSTOMER_CREDIT_ACCOUNT_NAME, depositLiabilityAccount } from "./accounting/customerCreditPolicy";
import { round2 } from "../lib/money";
import { requireIssuanceSeller } from "./sellerIdentity";
import { enqueueEInvoice } from "./einvoice/outbox/enqueue";
import { BusinessRuleError } from "../lib/errors";
import { logger } from "../lib/logger";
import { buildInvoiceOut, toNum, type InvoiceOut } from "./invoices.presenter";
import type { Approvable, ApprovalState } from "./approval";
import type { invoicesTable as InvoicesTable, customersTable } from "@workspace/db";
import { ADVANCE_INVOICE_TYPE, ADVANCE_CREDIT_NOTE_TYPE, RECOVERY_INVOICE_TYPE, INVOICE_IN_BOOKS_STATUSES } from "@workspace/shared";
import { advanceInvoicesRepository } from "../repositories/advanceInvoices.repository";
import { advanceInvoicesService, prepaymentsOf, assertTaxPointPeriodOpen } from "./advanceInvoices.service";
import type { GLLine } from "./accounting/glPosting";

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
  advance_invoice: "Advance tax invoice",
  advance_credit_note: "Credit note against advance",
  recovery_invoice: "Tax invoice (Art. 40(9) recovery)",
};

/**
 * AP-2 — re-validate an ADVANCE TAX INVOICE (386) at APPROVAL, under the
 * receipt's lock, before the ICV is consumed. The draft was checked at
 * create; the state can change while it sits in the queue: the deposit may
 * have been reclassified (A1: only a genuine taxable advance triggers 386),
 * allocated or refunded, or a concurrent 386 may have covered the remainder.
 * Returns the locked receipt.
 */
async function assertAdvanceInvoiceIssuable(inv: Invoice) {
  const [payment] = await paymentsRepository.lockPayment(inv.advancePaymentId!);
  if (!payment) throw new BusinessRuleError(409, { code: "advance_receipt_not_found", error: `The receipt advance tax invoice ${inv.invoiceNumber} declares VAT for no longer exists.` });
  if ((payment.customerId ?? null) !== (inv.customerId ?? null)) {
    throw new BusinessRuleError(409, { code: "advance_receipt_customer_mismatch", error: `Advance tax invoice ${inv.invoiceNumber} names a different customer than receipt ${payment.id}.` });
  }
  const classification = (await paymentsRepository.latestClassifications([payment.id])).get(payment.id) ?? null;
  const [line] = await invoicesRepository.itemsByInvoice(inv.id);
  if (!classification || classification.classification !== "advance" || (line && classification.vatCategory !== line.taxCategoryCode)) {
    throw new BusinessRuleError(409, {
      code: "advance_invoice_requires_advance_classification",
      error:
        `Receipt ${payment.id} is no longer classified as an advance for a taxable supply` +
        (classification?.classification === "advance" ? ` at VAT category ${line?.taxCategoryCode}` : "") +
        ` (current: ${classification?.classification ?? "unknown"}${classification?.vatCategory ? ` · ${classification.vatCategory}` : ""}). ` +
        `Reclassify the deposit, or delete this draft.`,
      field: "id",
      classification: classification?.classification ?? "unknown",
    });
  }
  if (inv.date < payment.paidAt) {
    throw new BusinessRuleError(422, { code: "advance_invoice_before_receipt", error: `Advance tax invoice ${inv.invoiceNumber} is dated ${inv.date}, before the receipt of ${payment.paidAt}: the tax point is the receipt.`, field: "date" });
  }
  const figures = await advanceInvoicesService.figuresFor(payment);
  const total = toNum(inv.total);
  if (total > figures.uninvoiced + 0.005) {
    throw new BusinessRuleError(422, {
      code: "advance_invoice_exceeds_uninvoiced",
      error: `Advance tax invoice ${inv.invoiceNumber} is ${total.toFixed(2)} but only ${figures.uninvoiced.toFixed(2)} of receipt ${payment.id} is still not covered by an advance tax invoice (on account ${figures.unapplied.toFixed(2)}, already invoiced and open ${figures.open.toFixed(2)}).`,
      field: "total",
      uninvoicedAmount: figures.uninvoiced.toFixed(2),
    });
  }
  return payment;
}

/**
 * AP-2 — re-validate a FINAL invoice's PREPAYMENT ADJUSTMENT at approval,
 * under the 386 rows' locks and the receipts' locks: every advance invoice
 * is issued, belongs to this customer and company, and still has the open
 * balance this invoice adjusts; Σ adjusted ≤ this invoice's total (the
 * over-advance default — Guideline §8(g) option 2: limit to the invoice).
 * Returns the rows with their receipts, ready to fold.
 */
async function assertPrepaymentsIssuable(inv: Invoice, total: number) {
  const rows = await advanceInvoicesRepository.prepaymentsOfInvoice(inv.id);
  if (rows.length === 0) return [];
  const locked = await invoiceSettlementRepository.lockInvoices(rows.map((r) => r.row.advanceInvoiceId));
  const byId = new Map(locked.map((a) => [a.id, a]));
  const balances = await advanceInvoicesRepository.openBalances(rows.map((r) => r.row.advanceInvoiceId));
  let sum = 0;
  const out: Array<{ row: (typeof rows)[number]["row"]; advance: Invoice; paymentId: number }> = [];
  for (const { row } of rows) {
    const adv = byId.get(row.advanceInvoiceId);
    const amount = toNum(row.amount);
    if (!adv || adv.documentType !== ADVANCE_INVOICE_TYPE || !(INVOICE_IN_BOOKS_STATUSES as readonly string[]).includes(adv.status)) {
      throw new BusinessRuleError(409, { code: "prepayment_advance_not_issued", error: `Advance tax invoice ${adv?.invoiceNumber ?? row.advanceInvoiceId} is not an issued advance tax invoice; this invoice cannot adjust it.`, field: "prepayments" });
    }
    if ((adv.customerId ?? null) !== (inv.customerId ?? null) || adv.companyId !== inv.companyId) {
      throw new BusinessRuleError(422, { code: "prepayment_party_mismatch", error: `Advance tax invoice ${adv.invoiceNumber} belongs to a different customer or company than invoice ${inv.invoiceNumber}.`, field: "prepayments" });
    }
    const open = balances.get(adv.id)?.open ?? toNum(adv.total);
    if (amount > open + 0.005) {
      throw new BusinessRuleError(409, {
        code: "prepayment_exceeds_open_advance",
        error: `Invoice ${inv.invoiceNumber} adjusts ${amount.toFixed(2)} of advance tax invoice ${adv.invoiceNumber}, but only ${open.toFixed(2)} of it is still open (another invoice adjusted, or a credit note cancelled, the rest).`,
        field: "prepayments",
        openAmount: open.toFixed(2),
      });
    }
    sum = Math.round((sum + amount) * 100) / 100;
    out.push({ row, advance: adv, paymentId: adv.advancePaymentId! });
  }
  if (sum > total + 0.005) {
    throw new BusinessRuleError(422, {
      code: "prepayment_exceeds_invoice",
      error: `The advances adjusted on invoice ${inv.invoiceNumber} total ${sum.toFixed(2)}, more than the invoice's ${total.toFixed(2)}. Adjust at most the invoice total; the remainder stays on the customer's deposit (or issue a credit note against the advance tax invoice).`,
      field: "prepayments",
    });
  }
  for (const paymentId of new Set(out.map((o) => o.paymentId))) await paymentsRepository.lockPayment(paymentId);
  return out;
}

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

  // Approval is when it hits the books — enforce the period lock first. An
  // advance tax invoice is dated at its TAX POINT (the receipt), so a locked
  // receipt month refuses with the Art. 63 explanation, not the generic one.
  if (inv.documentType === ADVANCE_INVOICE_TYPE && inv.advancePaymentId != null) {
    await assertTaxPointPeriodOpen({ id: inv.advancePaymentId, paidAt: inv.date });
  }
  await checkPeriodOpen(inv.date);

  // Re-validate a note at APPROVAL, not only at create (M12.1b). The state can
  // change while it sits in the queue: a concurrent note may have consumed the
  // remaining credit, or the original may have been corrected. `excludeNoteId`
  // stops this note counting against itself on the second pass.
  if (isNoteType(inv.documentType)) {
    // AP-3: a credit note against a 386 is capped by the 386's OPEN balance,
    // which a concurrent final invoice or note can consume — the 386 row is
    // locked first (the same lock the prepayment adjustment takes).
    if (inv.documentType === ADVANCE_CREDIT_NOTE_TYPE) await invoiceSettlementRepository.lockInvoices([inv.originalInvoiceId!]);
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

  // AP-2: an advance tax invoice is re-checked against its receipt under the
  // receipt's lock; a final invoice's prepayment adjustment against the
  // advance invoices it names under their locks — both BEFORE the ICV is
  // consumed (a refused issuance is recoverable; an ICV gap is not).
  const isAdvance = inv.documentType === ADVANCE_INVOICE_TYPE;
  if (isAdvance) await assertAdvanceInvoiceIssuable(inv);
  const prepayments = !isAdvance && !isNoteType(inv.documentType) ? await assertPrepaymentsIssuable(inv, total) : [];

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
  if (isAdvance) {
    /**
     * 🔴 AP-2 — E2, the ADVANCE TAX INVOICE's entry (accountant A2, pack §6):
     *
     *   Dr Customer deposits and advances (customer)   [the VAT part]
     *       Cr VAT Payable                              [the VAT part]
     *
     * The receipt already posted Dr Bank / Cr Customer deposits for the
     * GROSS (Batch 1B, unchanged). This entry splits the deposit: what
     * remains on the liability is the NET contract liability (IFRS 15.47 —
     * consideration excludes amounts collected for the government), and the
     * VAT is declared. Together the two dated documents equal exactly the
     * accountant's receipt entry (Dr Bank / Cr Deposit / Cr Output VAT).
     * No AR, no revenue: the cash already arrived and nothing was supplied.
     * A zero-rated or exempt advance (VAT 0) is a document with no entry.
     */
    if (vatAmount > 0) {
      const party = { type: "customer" as const, customerId: inv.customerId! };
      await postJournalEntry({
        entryNumber: `GL-${inv.invoiceNumber}`,
        date: inv.date,
        description: `Advance tax invoice ${inv.invoiceNumber} — VAT on advance received (receipt RCPT-${inv.advancePaymentId})`,
        reference: inv.invoiceNumber,
        lines: [
          { systemCode: CUSTOMER_CREDIT_ACCOUNT.deposit, accountName: CUSTOMER_CREDIT_ACCOUNT_NAME.deposit, description: `VAT declared on advance — ${inv.invoiceNumber}`, debitAmount: vatAmount, creditAmount: 0, party },
          { systemCode: "VAT_OUTPUT", accountName: "VAT Payable", description: `VAT on advance tax invoice ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: vatAmount },
        ],
      });
    }
  } else if (inv.documentType === ADVANCE_CREDIT_NOTE_TYPE) {
    /**
     * 🔴 AP-3 — E5, the CREDIT NOTE AGAINST AN ADVANCE TAX INVOICE (pack §6 E5;
     * Guideline §8(g); IR Art. 40(1)(a), 40(5), 54):
     *
     *   Dr VAT Payable                                  [the credited VAT]
     *       Cr Customer deposits and advances (customer) [the credited VAT]
     *
     * The advance is cancelled before its supply. E2 had moved the VAT part of
     * the deposit to VAT Payable; this returns it, so the deposit is the
     * GROSS cash again and the 386's open balance falls by the credited
     * amount — which is exactly what raises the receipt's un-invoiced
     * remainder and unlocks the Batch 1B deposit refund (Dr deposits / Cr
     * bank) for that part. No AR, no revenue, no allocation, no credit
     * balance: the money never left the receipt's deposit. The return files
     * the note's line NEGATIVE in the note's period (documentSign −1). A
     * zero-rated / exempt advance credits a document with no entry.
     */
    const [original] = await invoicesRepository.findById(inv.originalInvoiceId!);
    if (vatAmount > 0) {
      const party = { type: "customer" as const, customerId: inv.customerId! };
      await postJournalEntry({
        entryNumber: `GL-${inv.invoiceNumber}`,
        date: inv.date,
        description: `Credit note ${inv.invoiceNumber} against advance tax invoice ${original?.invoiceNumber ?? inv.originalInvoiceId} — VAT returned to the deposit`,
        reference: inv.invoiceNumber,
        lines: [
          { systemCode: "VAT_OUTPUT", accountName: "VAT Payable", description: `VAT on cancelled advance — ${inv.invoiceNumber}`, debitAmount: vatAmount, creditAmount: 0 },
          { systemCode: CUSTOMER_CREDIT_ACCOUNT.deposit, accountName: CUSTOMER_CREDIT_ACCOUNT_NAME.deposit, description: `Advance ${original?.invoiceNumber ?? ""} credited — VAT back on the deposit`, debitAmount: 0, creditAmount: vatAmount, party },
        ],
      });
    }
  } else if (inv.documentType === RECOVERY_INVOICE_TYPE) {
    /**
     * 🔴 2026-09-22 — THE Art. 40(9) RECOVERY INVOICE (accountant answer 4;
     * badDebt.service.ts carries the authority and the shape):
     *
     *   Dr Bad debts                 the VAT on the amount received
     *       Cr VAT Payable           the same — payable again, in the PAYMENT's period
     *
     * and, when the receivable was written off HERE (its money arrived on
     * account, on the receipt's liability):
     *
     *   Dr <receipt's liability>     the amount received (gross)
     *       Cr Bad debts             the recovery
     *
     * with an allocation receipt → this document for the gross (the receipt's
     * unapplied balance, this document's paid_amount and the GL agree). A
     * migrated receivable is settled by the receipt's own allocation; this
     * document then carries the VAT leg only. No AR, no revenue: the money
     * has been received. Re-checked here under the locks before the ICV
     * is consumed.
     */
    const [recovered] = await invoiceSettlementRepository.lockInvoices([inv.recoversInvoiceId!]);
    const [payment] = await paymentsRepository.lockPayment(inv.recoveryPaymentId!);
    if (!recovered || !payment) throw new BusinessRuleError(409, { code: "recovery_source_missing", error: `The receivable or the receipt this recovery invoice declares no longer exists.` });
    if (!recovered.badDebtReliefSource) throw new BusinessRuleError(409, { code: "recovery_requires_relief", error: `${recovered.invoiceNumber} no longer carries bad-debt relief; the recovery invoice cannot be issued.` });
    await assertTaxPointPeriodOpen({ id: payment.id, paidAt: payment.paidAt });
    const party = { type: "customer" as const, customerId: inv.customerId! };
    const writtenOffHere = toNum(recovered.writtenOffAmount) > 0.005 && recovered.badDebtReliefSource === "recorded";
    const lines: GLLine[] = [];
    if (vatAmount > 0.005) {
      lines.push({ systemCode: "BAD_DEBT_EXPENSE", accountName: "Bad debts", description: `VAT payable again on recovery of ${recovered.invoiceNumber} (Art. 40(9))`, debitAmount: vatAmount, creditAmount: 0 });
      lines.push({ systemCode: "VAT_OUTPUT", accountName: "VAT Payable", description: `VAT on ${inv.invoiceNumber} — recovery of ${recovered.invoiceNumber}`, debitAmount: 0, creditAmount: vatAmount });
    }
    if (writtenOffHere) {
      const allocated = round2((await paymentsRepository.allocatedTotals([payment.id])).get(payment.id) ?? 0);
      const refunded = round2(await paymentsRepository.refundedFrom({ paymentId: payment.id }));
      const available = round2(toNum(payment.amount) - allocated - refunded);
      if (total > available + 0.005) throw new BusinessRuleError(409, { code: "recovery_exceeds_receipt", error: `Receipt ${payment.id} has ${available.toFixed(2)} not yet applied; the recovery of ${total.toFixed(2)} cannot be issued from it.`, field: "amount" });
      const [dup] = await paymentsRepository.activeAllocationFor({ paymentId: payment.id }, inv.id);
      if (dup) throw new BusinessRuleError(409, { code: "recovery_receipt_already_allocated", error: `Receipt ${payment.id} is already applied to ${inv.invoiceNumber}.` });
      const liability = depositLiabilityAccount(((await paymentsRepository.latestClassifications([payment.id])).get(payment.id)?.classification as "advance" | "erroneous" | "security_deposit" | "unknown" | undefined) ?? null);
      lines.push({ systemCode: liability.systemCode, accountName: liability.accountName, description: `Receipt RCPT-${payment.id} applied to the recovery of ${recovered.invoiceNumber}`, debitAmount: total, creditAmount: 0, party });
      lines.push({ systemCode: "BAD_DEBT_EXPENSE", accountName: "Bad debts", description: `Bad debt recovered — ${recovered.invoiceNumber}`, debitAmount: 0, creditAmount: total });
    }
    let je: { id: number } | null = null;
    if (lines.length > 0) {
      je = await postJournalEntry({
        entryNumber: `GL-${inv.invoiceNumber}`,
        date: inv.date,
        description: `Tax invoice ${inv.invoiceNumber} under Art. 40(9): ${total.toFixed(2)} received on ${payment.paidAt} against ${recovered.invoiceNumber} (bad-debt relief ${recovered.badDebtReliefClaimedOn})`,
        reference: inv.invoiceNumber,
        lines,
      });
    }
    if (writtenOffHere) {
      await paymentsRepository.insertAllocation({ paymentId: payment.id, invoiceId: inv.id, amount: total.toFixed(2), journalEntryId: je?.id ?? null, createdBy: null });
      updated = await invoiceSettlementRepository.bumpSettled(inv.id, { paid: total }, inv.date, "paid");
    }
  } else if (total > 0) {
    const isCredit = inv.documentType === "credit_note";
    const label = DOCUMENT_LABEL[inv.documentType] ?? "Invoice";
    const party = inv.customerId != null ? { type: "customer" as const, customerId: inv.customerId } : { type: "none" as const, reason: "simplified/B2C invoice — no identified customer" };

    if (isCredit) {
      /**
       * 🔴 D-4 (2026-09-17): a credit note SETTLES its original up to what the
       * original still owes, and what is left over is a LIABILITY, not a
       * negative receivable (batch-1b decision pack §1.2, Model C):
       *
       *   applied = min(note total, original's outstanding)  → Cr AR(customer)
       *   excess  = note total − applied                    → Cr Customer credit balances(customer)
       *
       * The original is locked for the arithmetic; the applied part is recorded
       * as an allocation (source = this note → original) so `credited_amount`
       * and Σ allocations agree from the first day. The excess needs a
       * customer to be owed to — a simplified/B2C original with no identified
       * customer cannot carry a credit balance, so that case is refused
       * before anything posts (fail closed; the note stays approvable once the
       * customer is identified or the note is sized to the open balance).
       */
      const [original] = await invoiceSettlementRepository.lockInvoices([inv.originalInvoiceId!]);
      if (!original) throw new BusinessRuleError(409, { code: "note_original_not_found", error: `The invoice this credit note corrects no longer exists.` });
      const originalOutstanding = Math.max(0, round2(toNum(original.total) - toNum(original.paidAmount) - toNum(original.creditedAmount) - toNum(original.writtenOffAmount)));
      const applied = round2(Math.min(total, originalOutstanding));
      const excess = round2(total - applied);
      if (excess > 0 && inv.customerId == null) {
        throw new BusinessRuleError(422, {
          code: "credit_note_excess_unidentified_customer",
          error:
            `Credit note ${inv.invoiceNumber} is ${total.toFixed(2)} but invoice ${original.invoiceNumber} only has ${originalOutstanding.toFixed(2)} outstanding, ` +
            `and the invoice names no customer to owe the remaining ${excess.toFixed(2)} to. Identify the customer, or size the note to the open balance.`,
          field: "total",
        });
      }
      const lines = [
        // Reversed: revenue and output VAT are undone in full — that is the tax document's effect.
        { systemCode: "SALES" as const, accountName: "Sales Revenue", description: `${label} ${inv.invoiceNumber}`, debitAmount: subtotal, creditAmount: 0 },
        { systemCode: "VAT_OUTPUT" as const, accountName: "VAT Payable", description: `VAT on ${label.toLowerCase()} ${inv.invoiceNumber}`, debitAmount: vatAmount, creditAmount: 0 },
      ] as Parameters<typeof postJournalEntry>[0]["lines"];
      if (applied > 0) {
        lines.push({ systemCode: "AR", accountName: "Accounts Receivable", description: `${label} ${inv.invoiceNumber} against ${original.invoiceNumber}`, debitAmount: 0, creditAmount: applied, party });
      }
      if (excess > 0) {
        lines.push({ systemCode: CUSTOMER_CREDIT_ACCOUNT.credit_note, accountName: CUSTOMER_CREDIT_ACCOUNT_NAME.credit_note, description: `${label} ${inv.invoiceNumber} — balance owed to the customer`, debitAmount: 0, creditAmount: excess, party });
      }
      const je = await postJournalEntry({ entryNumber: `GL-${inv.invoiceNumber}`, date: inv.date, description: `${label} ${inv.invoiceNumber}`, reference: inv.invoiceNumber, lines });
      if (applied > 0) {
        await paymentsRepository.insertAllocation({ creditNoteId: inv.id, invoiceId: original.id, amount: applied.toFixed(2), journalEntryId: je.id, createdBy: null });
        await invoiceSettlementRepository.bumpSettled(original.id, { credited: applied });
      }
    } else if (prepayments.length === 0) {
      await postJournalEntry({
        entryNumber: `GL-${inv.invoiceNumber}`,
        date: inv.date,
        description: `${label} ${inv.invoiceNumber}`,
        reference: inv.invoiceNumber,
        lines: [
          { systemCode: "AR", accountName: "Accounts Receivable", description: `${label} ${inv.invoiceNumber}`, debitAmount: total, creditAmount: 0, party },
          { systemCode: "SALES", accountName: "Sales Revenue", description: `${label} ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: subtotal },
          { systemCode: "VAT_OUTPUT", accountName: "VAT Payable", description: `VAT on ${label.toLowerCase()} ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: vatAmount },
        ],
      });
    } else {
      /**
       * 🔴 AP-2 — E3, the FINAL invoice that ADJUSTS advance tax invoice(s)
       * (accountant A2, pack §6; XML Standard ¶9.5 — `PrepaidAmount`):
       *
       *   Dr Accounts Receivable (customer)        total − Σ adjusted (gross)   [the amount due, if any]
       *   Dr Customer deposits and advances (cust.) Σ adjusted taxable (KSA-31)  [the net advance released on performance]
       *       Cr Sales Revenue                      subtotal                     [the FULL supply]
       *       Cr VAT Payable                        vat − Σ adjusted VAT (KSA-32) [the VAT not already declared on the 386]
       *
       * ONE entry, dated as the document — the deposit's application is the
       * invoice's own act (A2), which is why it is folded here and not posted
       * as a later allocation (A3 governs those: dated the day of the act).
       * The allocation ROW is still written (receipt → this invoice, for the
       * gross), naming this entry, so the receipt's unapplied remainder, the
       * invoice's paid_amount and the prepayment row agree from the first
       * day; `paymentsService.unallocate` refuses it (the signed document
       * states the adjustment; a credit note corrects it). VAT already
       * declared on the 386 is never declared twice: the net line here and
       * the return's per-category deduction read the same rows.
       */
      const grossAdjusted = round2(prepayments.reduce((s, p) => s + toNum(p.row.amount), 0));
      const taxableAdjusted = round2(prepayments.reduce((s, p) => s + toNum(p.row.taxableAmount), 0));
      const vatAdjusted = round2(prepayments.reduce((s, p) => s + toNum(p.row.taxAmount), 0));
      const amountDue = round2(total - grossAdjusted);
      const vatNet = round2(vatAmount - vatAdjusted);
      const lines: GLLine[] = [];
      if (amountDue > 0.005) lines.push({ systemCode: "AR", accountName: "Accounts Receivable", description: `${label} ${inv.invoiceNumber} — amount due after advance`, debitAmount: amountDue, creditAmount: 0, party });
      if (taxableAdjusted > 0.005) lines.push({ systemCode: CUSTOMER_CREDIT_ACCOUNT.deposit, accountName: CUSTOMER_CREDIT_ACCOUNT_NAME.deposit, description: `Advance applied to ${inv.invoiceNumber} (${prepayments.map((p) => p.advance.invoiceNumber).join(", ")})`, debitAmount: taxableAdjusted, creditAmount: 0, party });
      lines.push({ systemCode: "SALES", accountName: "Sales Revenue", description: `${label} ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: subtotal });
      // A supply that ends up at a lower category than its advance can carry
      // LESS VAT than was declared on the 386: the difference reverses here.
      if (vatNet > 0.005) lines.push({ systemCode: "VAT_OUTPUT", accountName: "VAT Payable", description: `VAT on ${label.toLowerCase()} ${inv.invoiceNumber} net of advance`, debitAmount: 0, creditAmount: vatNet });
      else if (vatNet < -0.005) lines.push({ systemCode: "VAT_OUTPUT", accountName: "VAT Payable", description: `VAT declared on advance in excess of ${inv.invoiceNumber}`, debitAmount: -vatNet, creditAmount: 0 });
      const je = await postJournalEntry({
        entryNumber: `GL-${inv.invoiceNumber}`,
        date: inv.date,
        description: `${label} ${inv.invoiceNumber} — adjusting advance tax invoice(s) ${prepayments.map((p) => p.advance.invoiceNumber).join(", ")}`,
        reference: inv.invoiceNumber,
        lines,
      });
      // One allocation per receipt (one ACTIVE allocation per (source, invoice)); the prepayment rows name it.
      const perReceipt = new Map<number, number>();
      for (const p of prepayments) perReceipt.set(p.paymentId, round2((perReceipt.get(p.paymentId) ?? 0) + toNum(p.row.amount)));
      const allocationByReceipt = new Map<number, number>();
      for (const [paymentId, amount] of perReceipt) {
        const [dup] = await paymentsRepository.activeAllocationFor({ paymentId }, inv.id);
        if (dup) throw new BusinessRuleError(409, { code: "prepayment_receipt_already_allocated", error: `Receipt ${paymentId} is already allocated to invoice ${inv.invoiceNumber} (allocation ${dup.id}); the advance cannot be applied twice.`, field: "prepayments" });
        const alloc = await paymentsRepository.insertAllocation({ paymentId, invoiceId: inv.id, amount: amount.toFixed(2), journalEntryId: je.id, createdBy: null });
        allocationByReceipt.set(paymentId, alloc.id);
      }
      for (const p of prepayments) await advanceInvoicesRepository.setAllocation(p.row.id, allocationByReceipt.get(p.paymentId)!);
      // The caches move as for any cash settlement: paid_amount by the gross
      // applied (the customer's cash), status `paid` when nothing remains.
      updated = await invoiceSettlementRepository.bumpSettled(inv.id, { paid: grossAdjusted }, inv.date, amountDue < 0.01 ? "paid" : undefined);
    }
  }

  return buildInvoiceOut(updated, row.cust, undefined, await prepaymentsOf(updated));
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
