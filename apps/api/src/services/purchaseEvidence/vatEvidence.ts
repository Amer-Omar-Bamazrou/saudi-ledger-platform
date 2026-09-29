/**
 * 🔴 PHASE 13A (2026-09-24) — DOES THIS PURCHASE DOCUMENT EVIDENCE THE INPUT
 * VAT IT WOULD CLAIM? The ONE definition. Pure: every input is passed in, so
 * the verdict is the same wherever it is asked (a draft write, the preview the
 * review page shows, the approval that posts) and is testable without a
 * database.
 *
 * ── What the verdict rests on (Phase 13 research; nothing here is guessed) ──
 *  · Input tax may be deducted only while the taxable person HOLDS the
 *    evidence — the Agreement Art. 48 documents (a tax invoice) or, as
 *    alternative evidence, "a Simplified Tax Invoice which is correctly issued
 *    in accordance with these Regulations" (VAT IR Art. 49(7)(a)); 53(11)
 *    makes "Tax Invoice" include every Art. 53 invoice.
 *  · A tax invoice carries a sequential number and the supplier's VAT number
 *    (53(5)); a simplified invoice carries date, supplier name/address/VAT
 *    number, description, consideration and tax — no buyer details (53(8)).
 *  · A business may be given a SIMPLIFIED invoice only for a supply under
 *    SAR 1,000 (53(1)(c), the ARABIC text — the English says "summary").
 *    🔴 Read CONSERVATIVELY on the document's TOTAL: whether the SAR 1,000 is
 *    measured before or after VAT is not settled by the text read, so a
 *    simplified invoice is accepted only when even its total is under 1,000;
 *    between the two readings the VAT is held, never over-claimed.
 *  · A simplified tax invoice carries a ZATCA QR code in both e-invoicing
 *    phases, and since 4 Dec 2021 a deduction needs an invoice generated
 *    electronically; "Manual invoice will not be eligible for VAT deduction"
 *    (E-Invoicing Detailed Guideline §4.2, §7.1).
 *  · Art. 50 blocks the deduction for the listed purposes.
 *
 * ── Where the VAT then goes (accountant X1/X3/X5, 2026-09-27) ──────────────
 * `inputVatTreatment` below — the ONE mapping from verdict to books:
 *  · evidenced / nothing to claim → VAT_INPUT (claimed, on the return);
 *  · awaiting evidence → the document POSTS, its VAT in the holding asset
 *    VAT_AWAITING_EVIDENCE, never VAT_INPUT and never on the return, until
 *    the evidence entry (Dr VAT_INPUT / Cr holding) claims it in the period
 *    the evidence is held (IR Art. 49(8), five calendar years at most);
 *  · not deductible (Art. 50, a 0 %-recovery asset) → the cost, never input VAT;
 *  · a supplier credit note follows the document it corrects (X3).
 * An advance tax invoice (Z-AP1) is the exception: it is a VAT-only document,
 * so without evidence it has nothing to post and stays a draft.
 *
 * ── Product decisions (named, so they are not read as law) ─────────────────
 *  · A TAX invoice may be ATTESTED: the user states they hold it and supplies
 *    its facts; attaching the document raises the basis, it is not required.
 *  · A SIMPLIFIED invoice needs its QR READ from an attached document — the QR
 *    is the only machine-checkable proof that it was generated electronically.
 *  · OCR is never evidence: only the decoded QR and its server-checked
 *    signature are compared against the bill.
 */
import { QR_TAG, decodeTlv, readPhase1 } from "@workspace/zatca-tlv";
import { VAT_NUMBER_RE } from "../../lib/saudiIdentifiers";

export const SUPPLIER_DOCUMENT_KINDS = ["tax_invoice", "simplified_tax_invoice", "no_tax_invoice"] as const;
export type SupplierDocumentKind = (typeof SUPPLIER_DOCUMENT_KINDS)[number];

export type VatEvidenceStatus = "not_required" | "evidenced" | "awaiting_evidence" | "not_deductible";
export type VatEvidenceBasis = "qr_signature_verified" | "qr_unsigned" | "document_attached" | "attested";
export type FlagSeverity = "blocking" | "warning" | "info";

/** One reason, keyed by a STRUCTURED code the UI translates — never by its wording. */
export interface EvidenceFlag {
  code: string;
  severity: FlagSeverity;
  message: string;
}

export interface VatEvidenceInput {
  documentType: string;
  subtotal: number;
  vatAmount: number;
  total: number;
  /** The VAT this document's entry would CLAIM: its VAT less advance tax already claimed (Z-AP1). */
  vatToClaim: number;
  supplierDocumentKind: string | null;
  /** The supplier as recorded on the bill: null when the bill names none. */
  supplier: { vatNumber: string | null } | null;
  /** The SUPPLIER'S document number (bills.vendor_reference). */
  supplierInvoiceNumber: string | null;
  date: string;
  /** The existing fixed-asset treatment: a 0 % recovery asset capitalises its VAT and claims none. */
  capitalisesVat: boolean;
  /** The expense account, when it is marked Art. 50 blocked (`categories.input_vat_blocked`). */
  blockedExpenseAccount: { name: string } | null;
  /**
   * D-4a (owner, 2026-09-29): a DEBIT note's original, when that original's
   * input VAT was blocked under Art. 50. Optional — only the stored-document
   * path knows the original; the unsaved-form preview does not.
   */
  art50BlockedOriginal?: { billNumber: string } | null;
  /** The evidence document linked to the bill, if any. */
  capture: { qrPayload: string | null; signatureStatus: string | null } | null;
}

export interface VatEvidenceVerdict {
  status: VatEvidenceStatus;
  basis: VatEvidenceBasis | null;
  flags: EvidenceFlag[];
  // No "postable": since X1/X5 every purchase document posts, and the status
  // alone decides where its VAT goes (`inputVatTreatment`).
}

/** Where a posted purchase document's input VAT sits — `bills.input_vat_state`. */
export type InputVatState = "claimed" | "awaiting_evidence" | "not_deductible";

/**
 * 🔴 THE ONE MAPPING from the evidence verdict to the books (X1/X3/X5).
 * A supplier CREDIT note follows the document it corrects: reducing held VAT
 * reduces the holding account, reducing blocked VAT reduces the cost, and
 * reducing claimed VAT reduces VAT_INPUT in the note's own period (Art. 40(6)).
 * An original posted before Phase 13 carries no state and reads as claimed.
 */
export function inputVatTreatment(verdict: Pick<VatEvidenceVerdict, "status">, correctedOriginal?: { state: string | null } | null): InputVatState {
  if (correctedOriginal) return (correctedOriginal.state as InputVatState | null) ?? "claimed";
  if (verdict.status === "awaiting_evidence") return "awaiting_evidence";
  if (verdict.status === "not_deductible") return "not_deductible";
  return "claimed";
}

/**
 * IR Art. 49(8): input tax "may not be deducted in any period which falls
 * more than five calendar years after the calendar year in which the Supply
 * takes place". Calendar years, so a 2026 supply may be claimed through 2031.
 * The database trigger `bills_vat_evidence_gate` states the same rule.
 */
export function withinClaimWindow(supplyDate: string, claimDate: string): boolean {
  return claimDate >= supplyDate && Number(claimDate.slice(0, 4)) - Number(supplyDate.slice(0, 4)) <= 5;
}

/** SAR 1,000 — IR Art. 53(1)(c): a simplified invoice to a business only BELOW this. */
export const SIMPLIFIED_INVOICE_B2B_LIMIT = 1000;
const AMOUNT_TOLERANCE = 0.01;
const STANDARD_RATE = 0.15;

const blocking = (code: string, message: string): EvidenceFlag => ({ code, severity: "blocking", message });
const warning = (code: string, message: string): EvidenceFlag => ({ code, severity: "warning", message });
const info = (code: string, message: string): EvidenceFlag => ({ code, severity: "info", message });

/** The QR's own figures, decoded server-side. Null when there is no payload; throws never. */
function readQr(payload: string): { ok: true; vatNumber?: string; total?: number; vat?: number; timestamp?: string } | { ok: false } {
  try {
    const decoded = decodeTlv(payload);
    const p1 = readPhase1(decoded);
    const num = (s: string | undefined) => (s != null && s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : undefined);
    if (!decoded.tags.has(QR_TAG.VAT_NUMBER) && !decoded.tags.has(QR_TAG.TOTAL_WITH_VAT)) return { ok: false };
    return { ok: true, vatNumber: p1.vatNumber?.trim(), total: num(p1.totalWithVat), vat: num(p1.vatTotal), timestamp: p1.invoiceTimestamp };
  } catch {
    return { ok: false };
  }
}

export function evaluateVatEvidence(input: VatEvidenceInput): VatEvidenceVerdict {
  // ── nothing is claimed → nothing needs evidencing ──────────────────────────
  // A credit note REDUCES a claim (Art. 40(6)); holding a reduction back for
  // evidence would keep an over-claim alive. An advance credit note likewise.
  if (input.documentType === "credit_note" || input.documentType === "advance_credit_note") {
    return { status: "not_required", basis: null, flags: [] };
  }
  if (input.capitalisesVat) {
    return {
      status: "not_deductible", basis: null,
      flags: [info("vat_capitalised_fixed_asset",
        "This bill buys a fixed asset recorded with 0 % VAT recovery: its VAT is capitalised into the asset's cost (the existing fixed-asset treatment) and no input VAT is claimed.")],
    };
  }
  if (!(input.vatToClaim > 0)) return { status: "not_required", basis: null, flags: [] };

  // ── D-4a: a DEBIT note on an Art. 50-blocked supply is blocked too ─────────
  // IR Art. 50(1) blocks the input tax «المتعلقة بتلك النفقات» — it attaches to
  // the EXPENDITURE, not to a document (AUTH); IR 54(4) ties a debit note to the
  // invoice it adjusts, i.e. to the same expenditure (AUTH); IR 40(6) fixes the
  // period and grants no deduction (AUTH). That the debit note's extra VAT is
  // therefore blocked is one short inference from those rules — no text states
  // the debit-note case explicitly (design §19.9). Decided from the ORIGINAL,
  // never from the note's own expense account.
  if (input.documentType === "debit_note" && input.art50BlockedOriginal) {
    return {
      status: "not_deductible", basis: null,
      flags: [info("art50_blocked_original",
        `This debit note adjusts bill ${input.art50BlockedOriginal.billNumber}, whose input VAT is blocked under VAT IR Art. 50. ` +
        "The additional VAT on the same expense is blocked too: it is recorded as part of the cost and no input VAT is claimed.")],
    };
  }

  // ── Art. 50: blocked whatever the evidence; the VAT is part of the cost (X5) ─
  if (input.blockedExpenseAccount) {
    return {
      status: "not_deductible", basis: null,
      flags: [info("art50_blocked_expense_account",
        `The expense account "${input.blockedExpenseAccount.name}" is marked as blocked input VAT (VAT IR Art. 50), so this VAT cannot be claimed. ` +
        "It is recorded as part of the expense's cost; no input VAT is claimed.")],
    };
  }

  const flags: EvidenceFlag[] = [];
  const kind = input.supplierDocumentKind;

  // ── what document is held ──────────────────────────────────────────────────
  if (kind == null) {
    flags.push(blocking("document_kind_not_stated",
      "State which supplier document you hold — a tax invoice, a simplified tax invoice, or no tax invoice. Input VAT is claimed only on a tax invoice (VAT IR Art. 49(7))."));
  } else if (kind === "no_tax_invoice") {
    flags.push(blocking("no_tax_invoice",
      "The document you hold is not a tax invoice, so its VAT cannot be claimed (VAT IR Art. 49(7)). Obtain the supplier's tax invoice and record it here; the claim can then be made in the period you hold it (Art. 49(8))."));
  }

  // ── who issued it ──────────────────────────────────────────────────────────
  const vatNumber = input.supplier?.vatNumber?.trim() ?? "";
  if (!input.supplier) {
    flags.push(blocking("supplier_not_identified", "Choose the supplier: a tax invoice names the supplier and its VAT registration number (VAT IR Art. 53)."));
  } else if (!vatNumber) {
    flags.push(blocking("supplier_vat_number_missing",
      "The supplier has no VAT registration number on record. A tax invoice carries the supplier's VAT number (VAT IR Art. 53(5)(c), 53(8)(b)) — add it to the supplier."));
  } else if (!VAT_NUMBER_RE.test(vatNumber)) {
    flags.push(blocking("supplier_vat_number_invalid",
      `The supplier's VAT number "${vatNumber}" is not a valid Saudi VAT registration number (15 digits, starting and ending with 3).`));
  }

  // ── what a TAX invoice must show ───────────────────────────────────────────
  if (kind === "tax_invoice" && !(input.supplierInvoiceNumber ?? "").trim()) {
    flags.push(blocking("supplier_invoice_number_missing",
      "Enter the supplier's invoice number: a tax invoice carries a sequential number (VAT IR Art. 53(5)(b))."));
  }

  // ── a SIMPLIFIED invoice: the SAR 1,000 rule, and its QR ───────────────────
  if (kind === "simplified_tax_invoice") {
    if (input.total >= SIMPLIFIED_INVOICE_B2B_LIMIT) {
      flags.push(blocking("simplified_invoice_at_or_above_1000",
        `A simplified tax invoice may be issued to a business only for a supply under SAR ${SIMPLIFIED_INVOICE_B2B_LIMIT.toLocaleString("en-US")} (VAT IR Art. 53(1)(c)). ` +
        "For this amount the supplier must issue a full tax invoice — obtain it, and the claim can be made in the period you hold it."));
    }
    if (!input.capture) {
      flags.push(blocking("simplified_invoice_document_missing",
        "Attach the simplified tax invoice: it must carry a ZATCA QR code, and the QR is how the platform checks it was generated electronically (E-Invoicing Detailed Guideline §7.1)."));
    } else if (!input.capture.qrPayload) {
      flags.push(blocking("simplified_invoice_qr_missing",
        "No ZATCA QR code was read from the attached document. A simplified tax invoice carries one — rescan it so the QR is read, or obtain a full tax invoice."));
    }
  }

  // ── the QR, when there is one: compared with the bill, never trusted blind ─
  let basis: VatEvidenceBasis = "attested";
  if (input.capture) {
    basis = "document_attached";
    if (input.capture.qrPayload) {
      const qr = readQr(input.capture.qrPayload);
      if (!qr.ok) {
        const f = kind === "simplified_tax_invoice" ? blocking : warning;
        flags.push(f("qr_unreadable", "The document's QR code could not be read as a ZATCA QR code."));
      } else {
        if (qr.vatNumber && vatNumber && qr.vatNumber !== vatNumber) {
          flags.push(blocking("qr_supplier_vat_mismatch",
            `The invoice's QR code names supplier VAT number ${qr.vatNumber}, but this bill's supplier has ${vatNumber}. The document may belong to another supplier.`));
        }
        if (qr.total != null && Math.abs(qr.total - input.total) > AMOUNT_TOLERANCE) {
          flags.push(blocking("qr_total_mismatch",
            `The invoice's QR code states a total of ${qr.total.toFixed(2)}, but this bill records ${input.total.toFixed(2)}.`));
        }
        if (qr.vat != null && Math.abs(qr.vat - input.vatAmount) > AMOUNT_TOLERANCE) {
          flags.push(blocking("qr_vat_mismatch",
            `The invoice's QR code states VAT of ${qr.vat.toFixed(2)}, but this bill records ${input.vatAmount.toFixed(2)}.`));
        }
        if (qr.timestamp && qr.timestamp.slice(0, 10) !== input.date) {
          flags.push(warning("qr_date_differs", `The invoice's QR code is dated ${qr.timestamp.slice(0, 10)}; this bill is dated ${input.date}.`));
        }
        const sig = input.capture.signatureStatus;
        if (sig === "failed") {
          flags.push(blocking("qr_signature_failed",
            "The invoice's ZATCA cryptographic signature does NOT match its contents — the document may have been altered. Obtain a genuine copy from the supplier."));
        } else if (sig === "error") {
          flags.push(warning("qr_signature_unchecked", "The invoice's ZATCA signature could not be checked."));
        }
        basis = sig === "verified" ? "qr_signature_verified" : sig === "unsigned" ? "qr_unsigned" : "document_attached";
      }
    }
  }

  // ── arithmetic: noted, not evidence (the approval checks totals itself) ────
  if (input.subtotal > 0 && Math.abs(input.subtotal * STANDARD_RATE - input.vatAmount) > 0.05) {
    flags.push(warning("vat_rate_not_standard",
      `The VAT is ${((input.vatAmount / input.subtotal) * 100).toFixed(1)} % of the subtotal, not the standard 15 %. Check the figures, or whether the invoice mixes rates.`));
  }
  if (Math.abs(input.subtotal + input.vatAmount - input.total) > 0.02) {
    flags.push(warning("totals_do_not_reconcile", "The subtotal plus VAT does not equal the total."));
  }

  const held = flags.some((f) => f.severity === "blocking");
  return { status: held ? "awaiting_evidence" : "evidenced", basis, flags };
}

/** The blocking reasons as one sentence — the refusal message names what is missing. */
export function describeHold(verdict: VatEvidenceVerdict): string {
  return verdict.flags.filter((f) => f.severity === "blocking").map((f) => f.message).join(" ");
}
