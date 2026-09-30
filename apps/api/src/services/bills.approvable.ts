/**
 * Bill approval adapter — plugs bills into the generic {@link approvalService}
 * (M10.3). Bills exercise the FULL state machine: draft → submitted → approved,
 * with send-back to draft for correction.
 *
 * State mapping (spec §9, §10):
 *   draft     → draft      (editable, not in the books nor the approval queue)
 *   submitted → submitted  (locked, awaiting approval; not in the books)
 *   received  → approved   (posted to the GL: AP / expense / input VAT)
 *   paid      → approved   (post-approval; cannot be re-approved)
 *   overdue   → approved   (post-approval)
 *
 * `onApprove` is the entity's activation: the EXISTING bill post-to-GL path,
 * moved here unchanged — totals reconciliation, ZATCA vendor-VAT validation
 * (both overridable with `force`), the period-lock check (via postJournalEntry),
 * and the Dr Purchases/Input VAT / Cr Accounts Payable entry. Approval is the
 * only thing that makes a bill affect AP/expense/VAT.
 *
 * Built as a per-request factory because approval carries request options
 * (`debitAccount`, `force`); submit/send-back/reject need no options.
 */
import { BusinessRuleError } from "../lib/errors";
import { round2 } from "../lib/money";
import { postJournalEntry } from "./accounting/glPosting";
import { documentSign } from "../repositories/reports.repository";
import { billsRepository } from "../repositories/bills.repository";
import { assetCapitalisationService } from "./assets/capitalisation.service";
import { categoriesRepository } from "../repositories/categories.repository";
import { captureService } from "./capture/capture.service";
import { blockedAccount, vatEvidenceService } from "./purchaseEvidence/vatEvidence.service";
import { describeHold, inputVatTreatment, type VatEvidenceVerdict } from "./purchaseEvidence/vatEvidence";
import { payBill } from "./bills.payment";
import { buildBillOut, toNum, type BillOut } from "./bills.presenter";
import { supplierAdvanceInvoicesService } from "./accounting/supplierAdvanceInvoices.service";
import { inputVatLedgerService } from "./accounting/inputVatLedger.service";
import { SUPPLIER_ON_ACCOUNT_ASSET_NAME } from "./accounting/supplierCreditPolicy";
import type { Approvable, ApprovalActor, ApprovalState } from "./approval";
import type { billsTable, vendorsTable } from "@workspace/db";

type Bill = typeof billsTable.$inferSelect;
type Vendor = typeof vendorsTable.$inferSelect;
type BillRow = { bill: Bill; vendor: Vendor | null };

// Validation constants (mirror receiptValidator.ts on the frontend).
const RECONCILE_TOLERANCE = 0.02;

/**
 * The expense line's account, resolved against the TENANT'S chart — by id
 * first, by legacy name second — and refused, visibly, when a supplied value
 * matches nothing. Only when NOTHING is supplied does the line take the
 * PURCHASES system account, and then under that account's real name. The
 * stored label is always the resolved account's own name: the label and the
 * account cannot disagree by construction.
 */
async function resolveExpenseLine(
  debitAccountId: unknown,
  debitAccount: unknown,
): Promise<{ accountId: number; accountName: string } | { systemCode: "PURCHASES"; accountName: string }> {
  const refuse = (supplied: string): never => {
    throw new BusinessRuleError(422, {
      error:
        `Expense account ${supplied} is not an expense account in this company's chart of accounts. ` +
        "Choose one of the tenant's expense accounts (GET /categories, type = expense) and post again.",
      code: "expense_account_unresolved",
      field: "debitAccountId",
    });
  };

  if (debitAccountId != null && debitAccountId !== "") {
    const id = Number(debitAccountId);
    const chosen = Number.isInteger(id) && id > 0 ? await categoriesRepository.findById(id) : null;
    // RLS scopes findById to the tenant, so another org's id and a missing id
    // are the same absence; a non-expense account is refused the same way.
    if (!chosen || chosen.type !== "expense") return refuse(`#${String(debitAccountId)}`);
    return { accountId: chosen.id, accountName: chosen.name };
  }

  if (typeof debitAccount === "string" && debitAccount.trim()) {
    const name = debitAccount.trim();
    const chosen = await categoriesRepository.findByName(name);
    if (!chosen || chosen.type !== "expense") return refuse(`"${name}"`);
    return { accountId: chosen.id, accountName: chosen.name };
  }

  // Nothing supplied: the one default, under its REAL name.
  const purchases = await categoriesRepository.findBySystemCode("PURCHASES");
  return { systemCode: "PURCHASES" as const, accountName: purchases?.name ?? "Purchases" };
}
const ZATCA_VAT_RE = /^3\d{13}3$/;

/**
 * 🔴 PHASE 13A — a supplier's ADVANCE tax invoice (Z-AP1) is a VAT-only
 * document: its entry IS the claim (Dr Input VAT / Cr Supplier advances). With
 * evidence that does not support the claim there is nothing else to post, so
 * it stays a draft and the refusal names what is missing. Every OTHER purchase
 * document posts whatever its evidence — X1/X5 decide where its VAT goes.
 */
function refuseUnevidenced(verdict: VatEvidenceVerdict): never {
  const notDeductible = verdict.status === "not_deductible";
  throw new BusinessRuleError(422, {
    code: notDeductible ? "input_vat_not_deductible" : "input_vat_evidence_insufficient",
    error:
      "A supplier's advance tax invoice only claims input VAT, and its evidence does not support the claim — so it cannot be posted; it stays a draft. " +
      describeHold(verdict),
    vatEvidenceStatus: verdict.status,
    flags: verdict.flags,
  });
}

export interface BillApproveOptions {
  /** The id of an expense account in the tenant's chart — the resolved form. */
  debitAccountId?: unknown;
  /** Legacy: an account NAME. Matched against the chart; refused if it matches nothing. */
  debitAccount?: unknown;
  /**
   * The captured document this bill came from (A1).
   *
   * 🔴 Attached INSIDE this transaction, which is what makes the link atomic
   * with the posting: if the bill rolls back, so does the capture's claim to be
   * its evidence. Only the INTENT commits here — the bytes move into the
   * immutable archive afterwards, via the promotion job, because object storage
   * is not transactional with Postgres. Same pattern as M12.6's outbox.
   */
  captureId?: string;
  force?: boolean;
}

/**
 * The bill as every read returns it — with its outstanding, its advance
 * deductions and what is left to pay (Z-AP1). One builder for every response
 * this adapter gives, so an approval can never answer `prepaidAmount: 0` for a
 * bill that deducted an advance.
 */
async function fullOut(billId: number): Promise<BillOut> {
  const [r] = await billsRepository.findWithVendor(billId);
  const items = await billsRepository.itemsByBill(billId);
  const prepayments = await supplierAdvanceInvoicesService.prepaymentsOf(billId);
  return buildBillOut(r!.bill, r!.vendor, items, r!.outstanding, r!.prepaid, prepayments);
}

async function snapshot(row: BillRow): Promise<BillOut> {
  return fullOut(row.bill.id);
}

/**
 * The bill's on-approve action: the existing post-to-GL path, unchanged. Runs
 * only on a transition into `approved` (from draft or the submitted queue).
 */
async function postBillToGL(row: BillRow, opts: BillApproveOptions, actor: ApprovalActor): Promise<BillOut> {
  const { debitAccountId, debitAccount, force = false, captureId } = opts;
  const bill = row.bill;

  const subtotal = toNum(bill.subtotal);
  const vatAmount = toNum(bill.vatAmount);
  const total = toNum(bill.total);

  if (total <= 0) {
    throw new BusinessRuleError(400, { error: "Bill total must be greater than zero to post.", code: "ZERO_TOTAL" });
  }

  // ── totals reconciliation ──
  const computed = Math.round((subtotal + vatAmount) * 100) / 100;
  const diff = Math.abs(computed - total);
  let effectiveTotal = total;
  if (diff > RECONCILE_TOLERANCE) {
    if (!force) {
      throw new BusinessRuleError(400, {
        error: `Totals don't reconcile: ${subtotal} + ${vatAmount} = ${computed} but total is ${total} (difference: ${diff.toFixed(2)} SAR). Correct the amounts or pass force:true to override.`,
        code: "TOTALS_MISMATCH",
        detail: { subtotal, vatAmount, computedTotal: computed, storedTotal: total, diff },
      });
    }
    effectiveTotal = computed;
    console.warn(
      `[FORCE-POST] bill ${bill.id} (${bill.billNumber}) posted with TOTALS_MISMATCH ` +
        `diff=${diff.toFixed(2)} SAR; using computed total ${computed} for GL — ` +
        `userId=${actor.userId ?? "unknown"} at ${new Date().toISOString()}`,
    );
  }

  /**
   * 🔴 Z-AP1 (2026-09-24, accountant answer A) — the SUPPLIER'S ADVANCE
   * documents post only their VAT: the advance tax invoice CLAIMS it (Dr Input
   * VAT / Cr Supplier advances), the supplier's credit note against it
   * reverses it (the mirror), each in its own date's period. Neither touches
   * AP or an expense — the advance was paid before either existed.
   * (supplierAdvanceInvoices.service; the same approval path, one writer.)
   */
  if (bill.documentType === "advance_invoice" || bill.documentType === "advance_credit_note") {
    // Phase 13A: the supplier's advance TAX invoice claims input VAT, so its
    // evidence is decided like any other claim (a credit note: not required).
    const { verdict, capture } = await vatEvidenceService.evaluate(bill, row.vendor);
    if (verdict.status !== "evidenced" && verdict.status !== "not_required") refuseUnevidenced(verdict);
    // Phase 13B-3: the advance credit note is an event of the ADVANCE INVOICE it
    // corrects — locked, then asked O-2 / D-6 before anything posts.
    const advance = bill.documentType === "advance_credit_note" && bill.creditNoteAgainstBillId != null
      ? await billsRepository.lockForUpdate(bill.creditNoteAgainstBillId)
      : null;
    if (advance) await inputVatLedgerService.assertNoteAdmissible(bill, advance);
    const entryId = bill.documentType === "advance_invoice"
      ? await supplierAdvanceInvoicesService.approveAdvanceInvoice(bill)
      : await supplierAdvanceInvoicesService.approveAdvanceCreditNote(bill);
    await inputVatLedgerService.recordPosting({
      bill, treatment: "claimed", vatToClaim: toNum(bill.vatAmount), entryId, original: advance, verdict,
      capture: capture ? { id: capture.id, sha256: capture.sha256 } : null,
      columns: { status: "received", reviewNote: null, ...vatEvidenceService.columns(verdict) },
      userId: actor.userId ?? null,
    });
    return fullOut(bill.id);
  }

  // ── vendor ZATCA VAT number format ──
  const vendorVat = row.vendor?.taxNumber?.trim() ?? "";
  if (vendorVat && !ZATCA_VAT_RE.test(vendorVat)) {
    if (!force) {
      throw new BusinessRuleError(400, {
        error: `Vendor VAT number "${vendorVat}" is not in ZATCA format (15 digits, first and last digit '3'). Correct the vendor record or pass force:true to override.`,
        code: "INVALID_VAT_NUMBER",
        detail: { vendorId: row.vendor?.id, vendorVat },
      });
    }
    console.warn(
      `[FORCE-POST] bill ${bill.id} (${bill.billNumber}) posted with INVALID_VAT_NUMBER ` +
        `vatNumber=${vendorVat} — userId=${actor.userId ?? "unknown"} at ${new Date().toISOString()}`,
    );
  }

  // ── GL: Dr Purchases/Input VAT / Cr Accounts Payable ──
  //
  // M13: the expense line is the ONE line here whose account the USER chooses.
  // `debitAccount` is free text they supply per bill, so unlike our own posting
  // literals it is legitimate to resolve it BY NAME — the name is their account's
  // name, not one of our hardcoded strings. If it names a real account in their
  // chart we honour it; otherwise the line still classifies correctly as an
  // expense via PURCHASES, keeping their text as the display label.
  //
  // Choosing a specific expense account per bill (a picker over the real chart
  // rather than free text) is a follow-up — it is a UX change, not a
  // classification one, and the classification is what M13 is fixing.
  // 🔴 RESOLVED BY ID, AND NEVER SILENTLY ELSEWHERE (2026-09-15). The old
  // arm took a NAME, matched it against the chart, and on a miss posted to
  // PURCHASES while STORING THE NAME THE USER CHOSE as the line's label — so
  // 11 of the 14 names the picker offered (the default included) posted to
  // Purchases under a label that said otherwise: posts AND hides, the class
  // that made the empty journal date critical. Now: an id resolves against
  // the tenant's own chart (RLS-scoped, so another org's id and a missing id
  // are the same refusal); a legacy name resolves case-insensitively; a supplied
  // value that resolves to NOTHING is refused with the next step named; and
  // the stored label is always the account's REAL name. With nothing supplied
  // the line posts to the PURCHASES system account under its real name — the
  // one default, stated in the contract, no longer wearing another label.
  // The request body wins when it names an account; otherwise the account
  // chosen at ENTRY (bills.expense_account_id) — which is what survives the
  // submit → approve path, where the Approvals queue sends no body.
  // 🔴 FA-B (2026-09-22): a bill may buy a FIXED ASSET. The debit line is then
  // the asset CATEGORY's cost account instead of an expense account, and the
  // asset is capitalised on THIS entry inside THIS transaction — one writer for
  // one effect (fixed-assets pack §3 A1, §21). Non-deductible input VAT (a
  // restricted motor vehicle, Art. 50) is CAPITALISED into the cost rather than
  // deducted, which is why the plan decides the VAT line rather than the bill.
  /**
   * 🔴 B7 (2026-09-22) — THE PURCHASE-SIDE NOTE POSTS THROUGH THIS PATH,
   * MIRRORED, rather than through a second posting path of its own. One writer
   * per effect: a supplier credit note moves exactly the accounts a bill moves,
   * in the opposite direction.
   *
   *   bill / debit note   Dr expense  Dr input VAT   Cr AP
   *   credit note         Cr expense  Cr input VAT   Dr AP
   *
   * The sign is `documentSign()` — the ONE definition the AR side, the VAT
   * return and the ageings already use — never a local rule, and a DEBIT note
   * is +1 because it is an additional charge, not a reversal.
   *
   * 🔴 Amounts stay POSITIVE in storage and the direction lives in the type:
   * a stored negative is the failure mode this codebase already documented
   * (a negative `vat_amount` computes a rate of 0 and files a note in the
   * zero-rated box).
   */
  const sign = documentSign(bill.documentType);
  const isNote = bill.documentType === "credit_note";

  /**
   * 🔴 A note against a CAPITALISED bill is refused rather than posted
   * approximately. Reversing part of an asset's cost changes a depreciation
   * schedule whose posted rows are FROZEN, and the register — not this path —
   * owns that correction (fixed-assets pack §21). Refusing names the next
   * step; posting would put the register and the GL out of agreement in the
   * exact place `/assets/report` exists to surface.
   */
  if (isNote && bill.capitalisesAssetId != null) {
    throw new BusinessRuleError(422, {
      error: "This note adjusts a bill that capitalised a fixed asset. Correct the asset in the register (a cost adjustment or a disposal) rather than through a purchase note — the depreciation already posted would otherwise disagree with the asset's cost.",
      code: "note_against_capitalised_bill",
      field: "creditNoteAgainstBillId",
    });
  }

  const plan = bill.capitalisesAssetId != null
    ? await assetCapitalisationService.billCapitalisationPlan(bill.capitalisesAssetId, subtotal, vatAmount)
    : null;
  const debitLine = plan
    ? { accountId: plan.costAccountId, accountName: plan.costAccountName, description: `Asset ${plan.asset.assetNumber} — ${plan.asset.name}` }
    : { ...(await resolveExpenseLine(debitAccountId ?? bill.expenseAccountId ?? undefined, debitAccount)), description: `Bill ${bill.billNumber}` };
  let debitAmount = plan ? plan.capitalised : subtotal;
  /**
   * 🔴 Z-AP1 — a FINAL bill that deducts the supplier's advance tax
   * invoice(s). Its lines are the FULL supply; the advance invoice already
   * CLAIMED its VAT, so this entry claims only the rest (VAT − Σ prepaid tax),
   * credits AP only with what is still owed (total − Σ prepaid), and releases
   * the net advance from the asset (Cr Supplier advances Σ prepaid taxable).
   * THE SAME INPUT VAT IS NEVER CLAIMED TWICE. Re-checked under every advance
   * payment's lock before anything posts.
   */
  const prepaid = isNote ? null : await supplierAdvanceInvoicesService.lockAndCheckFinalBill(bill);
  /**
   * 🔴 Art. 40(6): on a purchase note the CUSTOMER corrects its INPUT tax "in
   * the Tax Period in which the Credit Note or Debit Note is issued" — the
   * note's own `date`, which is the SUPPLIER'S issue date. The VAT return
   * filters on that date, so the correction lands in the right period by
   * construction; nothing re-dates into the original bill's period.
   */
  const vatToClaim = round2(vatAmount - (prepaid?.tax ?? 0));
  /**
   * 🔴 Phase 13A — the evidence verdict, AUTHORITATIVELY, on the entry as it
   * will post: the account actually resolved (the body may override the
   * bill's own), the advance VAT already claimed, the fixed-asset treatment,
   * and the document linked as evidence. Decided before anything posts.
   */
  const expenseAccountId = !plan && "accountId" in debitLine ? debitLine.accountId : null;
  const { verdict: evidence, capture: evidenceCapture } = await vatEvidenceService.evaluate(bill, row.vendor, {
    expenseAccountId,
    captureId: captureId ?? null,
    prepaidTax: prepaid?.tax ?? 0,
    capitalisesVat: plan?.capitaliseVat ?? false,
  });
  /**
   * 🔴 WHERE THE VAT GOES (accountant X1/X3/X5) — `inputVatTreatment`, the one
   * mapping. The document posts in every case; what the evidence decides is
   * the ACCOUNT:
   *
   *   claimed            Dr VAT_INPUT              (the return claims it, this date)
   *   awaiting_evidence  Dr VAT_AWAITING_EVIDENCE  (an asset; no return claim until
   *                                                 the evidence entry moves it)
   *   not_deductible     Dr the expense / asset    (Art. 50, 0 % recovery: cost)
   *
   * A supplier CREDIT note follows the original it corrects (X3), mirrored:
   * against held VAT it reduces the held amount — never VAT_INPUT, never the
   * return — so the later claim is the NET; against blocked VAT it reduces
   * the cost. The original's row is locked, so a note and the evidence entry
   * cannot interleave on the same held balance.
   */
  const original = isNote && bill.creditNoteAgainstBillId != null
    ? await billsRepository.lockForUpdate(bill.creditNoteAgainstBillId)
    : null;
  const treatment = inputVatTreatment(evidence, original ? { state: original.inputVatState } : null);
  /**
   * 🔴 PHASE 13B-3 — O-2 AND D-6, BEFORE ANYTHING POSTS. A supplier credit note
   * is an event of its ORIGINAL (B-1); the ledger decides whether it can be
   * recorded: never dated before the original, never more VAT than the
   * original charged less its other notes (CI-1, IR Art. 54(1) — this replaces
   * the held-only cap, which it contains), and only from the original's single
   * VAT position — every undecided case refused by name (CN-1…CN-8).
   */
  if (original) {
    const bucket = await inputVatLedgerService.assertNoteAdmissible(bill, original);
    const expected = { claimed: "CLAIMED", awaiting_evidence: "HELD", not_deductible: "BLOCKED" }[treatment];
    if (bucket && bucket !== expected) {
      throw new BusinessRuleError(409, {
        code: "input_vat_ledger_divergence",
        error: `${original.billNumber}'s input VAT reads ${original.inputVatState ?? "unstated"} on the bill but ${bucket} in the VAT ledger. Nothing was posted; this needs investigating before the note can be recorded.`,
      });
    }
  }
  /**
   * Art. 50 VAT that a supplier's advance tax invoice already CLAIMED (Z-AP1)
   * cannot be made non-deductible by moving the rest into cost: the claim is on
   * the advance invoice's own return. Refused, naming the next step, rather
   * than posted half-claimed.
   */
  if (!isNote && (prepaid?.tax ?? 0) > 0 && !plan && (await blockedAccount(expenseAccountId))) {
    throw new BusinessRuleError(422, {
      code: "blocked_vat_claimed_on_advance",
      error: "This bill is on an expense account whose input VAT is blocked (VAT IR Art. 50), but it deducts a supplier advance tax invoice that already claimed VAT. Correct the advance invoice with the supplier's credit note first, or choose the right expense account.",
      field: "debitAccountId",
    });
  }
  const vatAccount = treatment === "claimed"
    ? { systemCode: "VAT_INPUT" as const, accountName: "Input VAT Receivable" }
    : treatment === "awaiting_evidence"
      // The held VAT is the ORIGINAL's: a note reducing it names the original's supplier, so the holding account reconciles by vendor.
      ? (() => {
          const heldVendorId = original?.vendorId ?? bill.vendorId;
          return { systemCode: "VAT_AWAITING_EVIDENCE" as const, accountName: "Input VAT awaiting evidence", ...(heldVendorId != null ? { party: { type: "vendor" as const, vendorId: heldVendorId } } : {}) };
        })()
      : null;
  const vatLine = !vatAccount || (plan && plan.capitaliseVat) || vatToClaim <= 0
    ? []
    : [{
        ...vatAccount,
        description: `VAT on ${bill.billNumber}`,
        ...(sign > 0 ? { debitAmount: vatToClaim, creditAmount: 0 } : { debitAmount: 0, creditAmount: vatToClaim }),
      }];
  // X5: blocked VAT is part of the expense line's cost (the fixed-asset plan already capitalises its own).
  if (treatment === "not_deductible" && !plan && vatToClaim > 0) debitAmount = round2(debitAmount + vatToClaim);

  const apAmount = round2(effectiveTotal - (prepaid?.amount ?? 0));
  const advanceLine = prepaid && prepaid.taxable > 0
    ? [{ systemCode: "SUPPLIER_ADVANCES" as const, accountName: SUPPLIER_ON_ACCOUNT_ASSET_NAME.SUPPLIER_ADVANCES!, description: `Advance deducted on ${bill.billNumber}`, debitAmount: 0, creditAmount: prepaid.taxable, party: { type: "vendor" as const, vendorId: bill.vendorId! } }]
    : [];

  /** Put an amount on the side this document type calls for — the whole sign rule, in one place. */
  const side = (amount: number, naturalDebit: boolean) =>
    (naturalDebit ? sign > 0 : sign < 0)
      ? { debitAmount: amount, creditAmount: 0 }
      : { debitAmount: 0, creditAmount: amount };

  const je = await postJournalEntry({
    entryNumber: isNote ? `BILLCN-${bill.billNumber}` : `BILL-${bill.billNumber}`,
    date: bill.date,
    description: `${isNote ? "Supplier credit note" : "Vendor bill"} ${bill.billNumber}${row.vendor?.name ? ` – ${row.vendor.name}` : ""}${plan ? ` (capitalised: ${plan.asset.assetNumber})` : ""}`,
    reference: bill.billNumber ?? undefined,
    lines: [
      { ...debitLine, ...side(debitAmount, true) },
      ...vatLine,
      ...advanceLine,
      ...(apAmount > 0 ? [{ systemCode: "AP" as const, accountName: "Accounts Payable", description: `${isNote ? "Credit note" : "Bill"} ${bill.billNumber}`, ...side(apAmount, false), party: bill.vendorId != null ? { type: "vendor" as const, vendorId: bill.vendorId } : { type: "none" as const, reason: "bill with no vendor record" } }] : []),
    ],
  });
  // Z-AP1: the advance now settles the bill — one folded allocation per advance payment, naming THIS entry.
  if (prepaid) await supplierAdvanceInvoicesService.finaliseFinalBill(bill.id, prepaid, je.id, actor.userId ?? null);

  // In the same transaction: the draft becomes an asset in service with its
  // stored schedule. If this throws, the bill does not post.
  if (plan) await assetCapitalisationService.capitaliseOnEntry(plan.asset.id, je.id, { kind: "bill", billId: bill.id, reference: bill.billNumber }, actor.userId ?? null);

  // 🔴 A1: bind the capture to the bill INSIDE this transaction, before the
  // status flips. A capture that cannot be attached (already used, discarded)
  // fails the whole approval rather than silently posting a bill whose evidence
  // is unaccounted for — the document is what supports the input-VAT deduction.
  // Phase 13A: the document linked to the DRAFT as its evidence is promoted
  // the same way — it becomes immutable evidence of the posted bill.
  const evidenceId = captureId ?? evidenceCapture?.id ?? null;
  if (evidenceId) await captureService.attachToBill(evidenceId, bill.id);

  // 🔴 PHASE 13B-3 — WHERE ITS VAT SITS, through the ONE writer: approved &
  // posted, any prior review note cleared, the verdict it posted on — and in
  // the SAME update the cache the trigger `bills_vat_evidence_gate` checks
  // against that verdict; then the events (recognition + one advance_deducted
  // per advance; a credit note's reduction on its original, which also lowers
  // the original's held amount — X3, its later claim is the net). At commit
  // `bills_input_vat_cache_consistency` refuses any disagreement.
  await inputVatLedgerService.recordPosting({
    bill, treatment, vatToClaim, entryId: je.id, original,
    prepayments: prepaid?.prepared.map((p) => ({ advanceBillId: p.advanceBillId, taxAmount: p.taxAmount })) ?? [],
    verdict: evidence,
    capture: evidenceCapture ? { id: evidenceCapture.id, sha256: evidenceCapture.sha256 } : null,
    columns: { status: "received", reviewNote: null, ...vatEvidenceService.columns(evidence) },
    userId: actor.userId ?? null,
  });

  /**
   * 🔴 PHASE 13C — AN EXPENSE IS PAID AS PART OF RECORDING IT. Its approval
   * pays what it owes through THE bill-payment path (`payBill` — the same
   * function the Pay button runs: the bill's row lock, `billPosition`'s
   * outstanding, the named bank, the period lock, the dated payment row and
   * its entry), from the bank and on the date the expense states. In this
   * transaction: if the payment cannot post (a closed month, an inactive
   * bank), the approval rolls back with it and nothing is left half-recorded.
   */
  if (bill.recordedAsExpense) {
    const owed = await billsRepository.outstandingOf(bill.id);
    if (owed >= 0.01) {
      await payBill(bill.id, { amount: owed, paidAt: bill.expensePaidAt ?? undefined, bankAccountId: bill.expensePaidFromBankAccountId }, actor.userId ?? null);
    }
  }
  return fullOut(bill.id);
}

/** Build the bill approval adapter for one request. */
export function billApprovable(opts: BillApproveOptions = {}): Approvable<BillRow, BillOut> {
  return {
    entityType: "bill",

    async load(id) {
      const [row] = await billsRepository.findWithVendor(id);
      return row ?? null;
    },

    state(row): ApprovalState {
      if (row.bill.status === "draft") return "draft";
      if (row.bill.status === "submitted") return "submitted";
      return "approved";
    },

    snapshot,

    onApprove(row, actor) {
      return postBillToGL(row, opts, actor);
    },

    async onSubmit(row) {
      // draft → submitted: enters the approver's queue, clears any prior note.
      await billsRepository.update(row.bill.id, { status: "submitted", reviewNote: null });
      return fullOut(row.bill.id);
    },

    async onSendBack(row, _actor, note) {
      // submitted → draft: returned for correction, note shown to the enterer.
      const [updated] = await billsRepository.update(row.bill.id, {
        status: "draft",
        reviewNote: note?.trim() ? note.trim() : null,
      });
      void updated;
      return fullOut(row.bill.id);
    },

    async hardDelete(row) {
      await billsRepository.remove(row.bill.id);
    },
  };
}
