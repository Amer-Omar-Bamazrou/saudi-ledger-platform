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
import { postJournalEntry } from "./accounting/glPosting";
import { billsRepository } from "../repositories/bills.repository";
import { assetCapitalisationService } from "./assets/capitalisation.service";
import { categoriesRepository } from "../repositories/categories.repository";
import { captureService } from "./capture/capture.service";
import { buildBillOut, toNum, type BillOut } from "./bills.presenter";
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

async function snapshot(row: BillRow): Promise<BillOut> {
  const items = await billsRepository.itemsByBill(row.bill.id);
  return buildBillOut(row.bill, row.vendor, items);
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
  const plan = bill.capitalisesAssetId != null
    ? await assetCapitalisationService.billCapitalisationPlan(bill.capitalisesAssetId, subtotal, vatAmount)
    : null;
  const debitLine = plan
    ? { accountId: plan.costAccountId, accountName: plan.costAccountName, description: `Asset ${plan.asset.assetNumber} — ${plan.asset.name}` }
    : { ...(await resolveExpenseLine(debitAccountId ?? bill.expenseAccountId ?? undefined, debitAccount)), description: `Bill ${bill.billNumber}` };
  const debitAmount = plan ? plan.capitalised : subtotal;
  const vatLine = plan && plan.capitaliseVat ? [] : [{ systemCode: "VAT_INPUT" as const, accountName: "Input VAT Receivable", description: `VAT on ${bill.billNumber}`, debitAmount: vatAmount, creditAmount: 0 }];

  const je = await postJournalEntry({
    entryNumber: `BILL-${bill.billNumber}`,
    date: bill.date,
    description: `Vendor bill ${bill.billNumber}${row.vendor?.name ? ` – ${row.vendor.name}` : ""}${plan ? ` (capitalised: ${plan.asset.assetNumber})` : ""}`,
    reference: bill.billNumber ?? undefined,
    lines: [
      { ...debitLine, debitAmount, creditAmount: 0 },
      ...vatLine,
      { systemCode: "AP", accountName: "Accounts Payable", description: `Bill ${bill.billNumber}`, debitAmount: 0, creditAmount: effectiveTotal, party: bill.vendorId != null ? { type: "vendor" as const, vendorId: bill.vendorId } : { type: "none" as const, reason: "bill with no vendor record" } },
    ],
  });

  // In the same transaction: the draft becomes an asset in service with its
  // stored schedule. If this throws, the bill does not post.
  if (plan) await assetCapitalisationService.capitaliseOnEntry(plan.asset.id, je.id, { kind: "bill", billId: bill.id, reference: bill.billNumber }, actor.userId ?? null);

  // 🔴 A1: bind the capture to the bill INSIDE this transaction, before the
  // status flips. A capture that cannot be attached (already used, discarded)
  // fails the whole approval rather than silently posting a bill whose evidence
  // is unaccounted for — the document is what supports the input-VAT deduction.
  if (captureId) await captureService.attachToBill(captureId, bill.id);

  // Approved & posted; clear any prior review note.
  const [updated] = await billsRepository.update(bill.id, { status: "received", reviewNote: null });
  return buildBillOut(updated, row.vendor);
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
      const [updated] = await billsRepository.update(row.bill.id, { status: "submitted", reviewNote: null });
      return buildBillOut(updated, row.vendor);
    },

    async onSendBack(row, _actor, note) {
      // submitted → draft: returned for correction, note shown to the enterer.
      const [updated] = await billsRepository.update(row.bill.id, {
        status: "draft",
        reviewNote: note?.trim() ? note.trim() : null,
      });
      return buildBillOut(updated, row.vendor);
    },

    async hardDelete(row) {
      await billsRepository.remove(row.bill.id);
    },
  };
}
