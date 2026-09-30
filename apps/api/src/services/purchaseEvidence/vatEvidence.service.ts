/**
 * Phase 13A — the VAT-evidence verdict, fed from real rows and PERSISTED on
 * the bill, so a user can find every document held for evidence and see why.
 *
 * The verdict itself is `vatEvidence.ts` (pure, the one definition). This
 * module only gathers its inputs — the supplier, the expense account's Art. 50
 * flag, the fixed-asset treatment, the advance VAT already claimed, the linked
 * document — and writes the answer. It is asked:
 *   · on every draft write (create, update, evidence attached, supplier's VAT
 *     number changed) — so the awaiting-evidence list is current;
 *   · by the review pages as a PREVIEW, before anything is saved;
 *   · at APPROVAL, authoritatively, where a verdict that cannot support the
 *     claim refuses the posting (bills.approvable) — and the database trigger
 *     `bills_vat_evidence_gate` refuses the transition to posted if any path
 *     ever forgets to ask.
 */
import type { billsTable, vendorsTable, capturedDocumentsTable } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { BusinessRuleError, NotFoundError } from "../../lib/errors";
import { round2 } from "../../lib/money";
import { postJournalEntry } from "../accounting/glPosting";
import { auditService } from "../audit.service";
import { billsRepository } from "../../repositories/bills.repository";
import { categoriesRepository } from "../../repositories/categories.repository";
import { assetsRepository } from "../../repositories/assets.repository";
import { vendorsRepository } from "../../repositories/vendors.repository";
import { capturedDocumentsRepository } from "../../repositories/capturedDocuments.repository";
import { supplierAdvanceInvoicesService } from "../accounting/supplierAdvanceInvoices.service";
import { inputVatLedgerService } from "../accounting/inputVatLedger.service";
import { SUPPLIER_DOCUMENT_KINDS, evaluateVatEvidence, withinClaimWindow, type VatEvidenceVerdict } from "./vatEvidence";

type Bill = typeof billsTable.$inferSelect;
type Vendor = typeof vendorsTable.$inferSelect;
type Capture = typeof capturedDocumentsTable.$inferSelect;

const UNPOSTED = new Set(["draft", "submitted"]);

/** The supplier-document kind, checked at the write boundary (the DB CHECK is the backstop). */
export function assertSupplierDocumentKind(v: unknown): void {
  if (v == null) return;
  if (!(SUPPLIER_DOCUMENT_KINDS as readonly string[]).includes(String(v))) {
    throw new BusinessRuleError(422, {
      code: "supplier_document_kind_invalid",
      error: `supplierDocumentKind must be one of: ${SUPPLIER_DOCUMENT_KINDS.join(", ")}.`,
      field: "supplierDocumentKind",
    });
  }
}

/** Is the expense line's account Art. 50 blocked? The PURCHASES default when none is chosen. */
export async function blockedAccount(expenseAccountId: number | null | undefined): Promise<{ name: string } | null> {
  const cat = expenseAccountId != null
    ? await categoriesRepository.findById(Number(expenseAccountId))
    : await categoriesRepository.findBySystemCode("PURCHASES");
  return cat?.inputVatBlocked ? { name: cat.name } : null;
}

/**
 * D-4a (owner, 2026-09-29): the original a DEBIT note adjusts, when its input
 * VAT was blocked under Art. 50 — posted as `not_deductible` on an expense
 * (not capitalised). A 0 %-recovery CAPITALISED original is also
 * `not_deductible`, but that is D-4b, deferred to G1 — deliberately NOT
 * matched here. An unposted original has no recorded treatment yet, so it is
 * not matched either.
 */
async function art50BlockedOriginal(bill: Bill): Promise<{ billNumber: string } | null> {
  if (bill.documentType !== "debit_note" || bill.creditNoteAgainstBillId == null) return null;
  const [original] = await billsRepository.findById(bill.creditNoteAgainstBillId);
  if (!original || UNPOSTED.has(original.status)) return null;
  return original.inputVatState === "not_deductible" && original.capitalisesAssetId == null
    ? { billNumber: original.billNumber }
    : null;
}

/** The EXISTING fixed-asset treatment: a 0 % recovery asset capitalises its VAT (claims none). */
async function capitalisesVat(assetId: number | null | undefined, vatAmount: number): Promise<boolean> {
  if (assetId == null || !(vatAmount > 0)) return false;
  const [row] = await assetsRepository.findById(Number(assetId));
  return row != null && Number(row.asset.vatInitialRecoveryPct) === 0;
}

/**
 * What the reviewer changed against the extraction — recomputed, never
 * accumulated, and stored BESIDE the extraction (which is never overwritten).
 */
function corrections(capture: Capture, bill: Bill, vendor: Vendor | null) {
  const x = (capture.extraction ?? null) as Record<string, unknown> | null;
  if (!x) return [];
  const pairs: Array<[string, unknown, unknown]> = [
    ["supplierVatNumber", x.supplierVatNumber, vendor?.taxNumber ?? null],
    ["invoiceNumber", x.vendorReference, bill.vendorReference],
    ["date", x.date, bill.date],
    ["subtotal", x.subtotal, Number(bill.subtotal)],
    ["vatAmount", x.vatAmount, Number(bill.vatAmount)],
    ["total", x.total, Number(bill.total)],
  ];
  const norm = (v: unknown) => (v == null || v === "" ? null : typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v)) ? round2(Number(v)) : String(v).trim());
  return pairs
    .filter(([, extracted]) => extracted != null && extracted !== "" && !(typeof extracted === "number" && extracted === 0))
    .filter(([, extracted, final]) => norm(extracted) !== norm(final))
    .map(([field, extracted, final]) => ({ field, extracted, final }));
}

export interface EvaluateOverrides {
  /** The account the approval RESOLVED (the body may override the bill's own). */
  expenseAccountId?: number | null;
  /** A capture named at approval (the legacy BillApproveInput.captureId). */
  captureId?: string | null;
  /** Advance VAT already claimed, when the approval has already computed it under lock. */
  prepaidTax?: number;
  /** The approval's own fixed-asset plan decision, when it has one. */
  capitalisesVat?: boolean;
}

export const vatEvidenceService = {
  /** The verdict for a stored bill, from its rows (plus any approval-time overrides). */
  async evaluate(bill: Bill, vendor: Vendor | null, o: EvaluateOverrides = {}): Promise<{ verdict: VatEvidenceVerdict; capture: Capture | null }> {
    const capture = o.captureId
      ? await capturedDocumentsRepository.findById(o.captureId)
      : await capturedDocumentsRepository.activeForBill(bill.id);
    const vat = Number(bill.vatAmount);
    const prepaidTax = o.prepaidTax ?? (await supplierAdvanceInvoicesService.prepaymentsOf(bill.id)).reduce((s, p) => s + p.taxAmount, 0);
    const verdict = evaluateVatEvidence({
      documentType: bill.documentType,
      subtotal: Number(bill.subtotal),
      vatAmount: vat,
      total: Number(bill.total),
      vatToClaim: round2(vat - prepaidTax),
      supplierDocumentKind: bill.supplierDocumentKind,
      supplier: vendor ? { vatNumber: vendor.taxNumber } : null,
      supplierInvoiceNumber: bill.vendorReference,
      date: bill.date,
      capitalisesVat: o.capitalisesVat ?? (await capitalisesVat(bill.capitalisesAssetId, vat)),
      blockedExpenseAccount: bill.capitalisesAssetId != null
        ? null
        : await blockedAccount(o.expenseAccountId !== undefined ? o.expenseAccountId : bill.expenseAccountId),
      art50BlockedOriginal: await art50BlockedOriginal(bill),
      capture: capture && capture.status !== "discarded" ? { qrPayload: capture.qrPayload, signatureStatus: capture.signatureStatus } : null,
    });
    return { verdict, capture: capture && capture.status !== "discarded" ? capture : null };
  },

  /** The stored fields a verdict writes onto the bill. */
  columns(verdict: VatEvidenceVerdict) {
    return {
      vatEvidenceStatus: verdict.status,
      vatEvidenceBasis: verdict.basis,
      vatEvidenceFlags: verdict.flags as never,
      vatEvidenceCheckedAt: new Date(),
    };
  },

  /**
   * Re-decide and PERSIST the verdict of an UNPOSTED bill, or of a POSTED one
   * whose VAT is still held for evidence (X1) — the verdict is what its claim
   * waits on. Any other posted bill's verdict is the one its approval
   * recorded and is never rewritten.
   */
  async refresh(billId: number): Promise<VatEvidenceVerdict | null> {
    const [row] = await billsRepository.findWithVendor(billId);
    if (!row || !(UNPOSTED.has(row.bill.status) || row.bill.inputVatState === "awaiting_evidence")) return null;
    const { verdict, capture } = await this.evaluate(row.bill, row.vendor);
    await billsRepository.update(billId, this.columns(verdict));
    if (capture) await capturedDocumentsRepository.setReviewCorrections(capture.id, corrections(capture, row.bill, row.vendor));
    return verdict;
  },

  /** A supplier's VAT number changed: every UNPOSTED bill of theirs is re-decided. */
  async refreshForVendor(vendorId: number): Promise<void> {
    for (const id of await billsRepository.unpostedIdsForVendor(vendorId)) await this.refresh(id);
  },

  /**
   * 🔴 X1 — THE EVIDENCE ENTRY. A posted document whose VAT is held in
   * VAT_AWAITING_EVIDENCE is re-judged; when the evidence now supports the
   * claim, what is still held moves into VAT_INPUT:
   *
   *     Dr VAT_INPUT  /  Cr VAT_AWAITING_EVIDENCE      (the held amount)
   *
   * dated the day the evidence is held — THAT is the claim's period (X2:
   * a later return, no prior-period correction), within five calendar years of
   * the supply (IR Art. 49(8)). The held amount is already net of any credit
   * note against the document (X3), and those notes follow it into the claim.
   * One act: the entry and the state move together, under the bill's row lock;
   * the trigger `bills_vat_evidence_gate` refuses any other change of state.
   * Returns null when the evidence still does not support the claim (the new
   * verdict is stored, nothing is posted).
   */
  async claimHeldVat(billId: number, opts: { date?: string | null; userId: number | null }): Promise<{ entryId: number | null; claimedOn: string } | null> {
    const bill = await billsRepository.lockForUpdate(billId);
    if (!bill) throw new NotFoundError("Not found");
    if (bill.inputVatState !== "awaiting_evidence") {
      throw new BusinessRuleError(409, {
        code: "input_vat_not_held",
        error: "This document's input VAT is not held for evidence — there is nothing to claim.",
      });
    }
    const verdict = await this.refresh(billId);
    if (verdict?.status !== "evidenced") return null;

    const today = businessToday();
    const claimedOn = opts.date ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(claimedOn)) {
      throw new BusinessRuleError(400, { code: "invalid_date", error: "The evidence date must be YYYY-MM-DD.", field: "evidenceDate" });
    }
    if (claimedOn > today) {
      throw new BusinessRuleError(422, { code: "evidence_date_in_future", error: "The evidence date cannot be in the future — the claim belongs to the period the evidence is actually held.", field: "evidenceDate" });
    }
    if (!withinClaimWindow(bill.date, claimedOn)) {
      throw new BusinessRuleError(422, {
        code: "input_vat_claim_window",
        error: claimedOn < bill.date
          ? `The evidence date ${claimedOn} is before the supply date ${bill.date}.`
          : `Input VAT on a supply dated ${bill.date} cannot be deducted in a period more than five calendar years after ${bill.date.slice(0, 4)} (VAT IR Art. 49(8)); ${claimedOn} is outside that window.`,
        field: "evidenceDate",
      });
    }

    // The claim is the NET of the credit notes already reducing it (X3), so it
    // cannot be dated before one of them: that note's reduction had not happened yet.
    const latestNote = await billsRepository.latestHeldNoteDate(billId);
    if (latestNote && claimedOn < latestNote) {
      throw new BusinessRuleError(422, {
        code: "evidence_date_before_credit_note",
        error: `A supplier credit note dated ${latestNote} has already reduced this bill's held VAT; the evidence date cannot be earlier than ${latestNote}.`,
        field: "evidenceDate",
      });
    }

    const amount = round2(Number(bill.inputVatPending));
    let entryId: number | null = null;
    if (amount > 0) {
      const [row] = await billsRepository.findWithVendor(billId);
      const label = `Input VAT evidenced — ${bill.billNumber}`;
      const je = await postJournalEntry({
        entryNumber: `VATEV-${bill.billNumber}`,
        date: claimedOn,
        description: `${label}${row?.vendor?.name ? ` – ${row.vendor.name}` : ""}`,
        reference: bill.billNumber ?? undefined,
        lines: [
          { systemCode: "VAT_INPUT", accountName: "Input VAT Receivable", description: label, debitAmount: amount, creditAmount: 0 },
          {
            systemCode: "VAT_AWAITING_EVIDENCE", accountName: "Input VAT awaiting evidence", description: label, debitAmount: 0, creditAmount: amount,
            ...(bill.vendorId != null ? { party: { type: "vendor" as const, vendorId: bill.vendorId } } : {}),
          },
        ],
      });
      entryId = je.id;
    }
    // 🔴 Phase 13B-3: the cache, the held notes following it, and the `claimed`
    // event (none when credit notes consumed the held VAT — O-6), through the ONE writer.
    const capture = await capturedDocumentsRepository.activeForBill(billId);
    const notes = await inputVatLedgerService.recordClaim({
      bill, amount, claimedOn, entryId, verdict,
      capture: capture && capture.status !== "discarded" ? { id: capture.id, sha256: capture.sha256 } : null,
      userId: opts.userId,
    });
    await auditService.record({
      action: "input_vat_claimed", entityType: "bill", entityId: billId,
      before: { inputVatState: "awaiting_evidence", inputVatPending: amount },
      after: { inputVatState: "claimed", claimedOn, amount, journalEntryId: entryId, creditNotesFollowing: notes.map((n) => n.id), userId: opts.userId },
    });
    return { entryId, claimedOn };
  },

  /**
   * The verdict for figures NOT YET SAVED — what the review page and the bill
   * form show while the user is still typing. Nothing is written.
   */
  async preview(body: {
    documentType?: string | null; supplierDocumentKind?: string | null; vendorId?: number | null;
    vendorReference?: string | null; date?: string | null; subtotal?: number | null; vatAmount?: number | null; total?: number | null;
    expenseAccountId?: number | null; capitalisesAssetId?: number | null; captureId?: string | null;
  }): Promise<VatEvidenceVerdict> {
    assertSupplierDocumentKind(body.supplierDocumentKind);
    const vendor = body.vendorId != null ? (await vendorsRepository.findById(Number(body.vendorId)))[0] ?? null : null;
    const capture = body.captureId ? await capturedDocumentsRepository.findById(body.captureId) : null;
    const vat = Number(body.vatAmount ?? 0);
    return evaluateVatEvidence({
      documentType: body.documentType ?? "bill",
      subtotal: Number(body.subtotal ?? 0),
      vatAmount: vat,
      total: Number(body.total ?? 0),
      vatToClaim: vat,
      supplierDocumentKind: body.supplierDocumentKind ?? null,
      supplier: vendor ? { vatNumber: vendor.taxNumber } : null,
      supplierInvoiceNumber: body.vendorReference ?? null,
      date: body.date ?? "",
      capitalisesVat: await capitalisesVat(body.capitalisesAssetId, vat),
      blockedExpenseAccount: body.capitalisesAssetId != null ? null : await blockedAccount(body.expenseAccountId),
      capture: capture && capture.status !== "discarded" ? { qrPayload: capture.qrPayload, signatureStatus: capture.signatureStatus } : null,
    });
  },
};
