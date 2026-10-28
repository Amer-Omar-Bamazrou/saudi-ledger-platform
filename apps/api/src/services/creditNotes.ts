/**
 * Credit / debit note validation (M12.1b).
 *
 * Kept separate from `invoices.service.ts` because these are the rules that make
 * a note a *note* rather than an invoice, and they are the ones a reviewer will
 * want to read in one place. The note itself is an ordinary `invoices` row —
 * same table, same approval workflow, same ZATCA chain.
 */
import { BusinessRuleError, NotFoundError } from "../lib/errors";
import { invoicesRepository } from "../repositories/invoices.repository";
import { assertNotReversedOpening } from "./accounting/openingReversed";
import { INVOICE_IN_BOOKS_STATUSES, ADVANCE_CREDIT_NOTE_TYPE, isAdvanceInvoiceType, isRecoveryInvoiceType } from "@workspace/shared";
import { advanceInvoicesRepository } from "../repositories/advanceInvoices.repository";
import { migrationCorrectionService } from "./migrationCorrection.service";
import { CHARGE_SUBSTANCES } from "@workspace/shared";

/**
 * AP-3: `advance_credit_note` is a note (ZATCA 381 with a billing reference
 * and a reason — BR-KSA-56, BR-KSA-17) whose ORIGINAL is an advance tax
 * invoice (386). It is its own type so no reader that sums `credit_note` as a
 * customer credit balance can mistake it (`@workspace/shared` documentTypes).
 */
export const NOTE_TYPES = ["credit_note", "debit_note", ADVANCE_CREDIT_NOTE_TYPE] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export function isNoteType(documentType: string | null | undefined): documentType is NoteType {
  return documentType === "credit_note" || documentType === "debit_note" || documentType === ADVANCE_CREDIT_NOTE_TYPE;
}

const LABEL: Record<NoteType, string> = {
  credit_note: "credit note",
  debit_note: "debit note",
  advance_credit_note: "credit note against an advance tax invoice",
};

/** States in which the ORIGINAL is a real, issued document a note can correct —
 *  the one definition in @workspace/shared (Issue 1). `overdue` was in this
 *  list once and is not a status any writer produces. */
const ISSUED_STATUSES: readonly string[] = INVOICE_IN_BOOKS_STATUSES;

const money = (v: unknown): number => Number(v ?? 0);
const fmt = (n: number): string => n.toFixed(2);

/** Decision 8 (`@workspace/shared` debitNoteCharge): what a debit note's extra charge IS — refused by name unless a price change. */
function assertChargeSubstance(substance: string | null | undefined): void {
  if (substance == null || substance === "") {
    throw new BusinessRuleError(400, {
      code: "debit_note_substance_required",
      error: "State what the extra charge IS: a change to the price of the original supply, a new supply, compensation for damage or loss, or a late-payment fee. There is no default.",
      field: "chargeSubstance",
    });
  }
  if (!(CHARGE_SUBSTANCES as readonly string[]).includes(substance)) {
    throw new BusinessRuleError(400, { code: "charge_substance_invalid", error: `chargeSubstance must be one of: ${CHARGE_SUBSTANCES.join(", ")}.`, field: "chargeSubstance" });
  }
  if (substance === "new_supply") {
    throw new BusinessRuleError(422, {
      code: "extra_charge_is_new_supply",
      error: "A distinct new supply is not a debit note: issue a new tax invoice for it.",
      field: "chargeSubstance",
    });
  }
  if (substance === "compensation") {
    throw new BusinessRuleError(422, {
      code: "extra_charge_is_compensation",
      error: "Compensation for damage or loss is not consideration for a supply, so it takes no VAT document (committee decision IR-2024-192725). Record it outside the VAT documents.",
      field: "chargeSubstance",
    });
  }
  if (substance === "late_payment_fee") {
    throw new BusinessRuleError(422, {
      code: "late_payment_fee_needs_substance",
      error: "A late-payment fee has no default treatment: classify it by what it is — a change to the price of the original supply, a new supply, or compensation.",
      field: "chargeSubstance",
    });
  }
}

function assertChargeEventDate(eventDate: string | null | undefined, original: { date: string; invoiceNumber: string }, noteDate: string | null | undefined): void {
  if (!eventDate) {
    throw new BusinessRuleError(400, { code: "charge_event_date_required", error: "Enter the date the price changed: the Art. 54(6) deadline runs from it.", field: "chargeEventDate" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    throw new BusinessRuleError(400, { code: "invalid_date", error: "chargeEventDate must be YYYY-MM-DD.", field: "chargeEventDate" });
  }
  if (eventDate < original.date) {
    throw new BusinessRuleError(422, {
      code: "charge_event_date_before_original",
      error: `The price of invoice ${original.invoiceNumber} cannot have changed on ${eventDate}, before the invoice itself (${original.date}).`,
      field: "chargeEventDate",
    });
  }
  if (noteDate && eventDate > noteDate) {
    throw new BusinessRuleError(422, {
      code: "charge_event_date_after_note",
      error: `The price change (${eventDate}) cannot come after the debit note recording it (${noteDate}).`,
      field: "chargeEventDate",
    });
  }
}

/**
 * Validate a note against its original.
 *
 * Runs at CREATE (so the enterer is told immediately) and again at APPROVAL —
 * the second pass matters because the state can change in between: a concurrent
 * note may consume the remaining credit while this one sits in the queue.
 */
export async function assertNoteIsValid(input: {
  documentType: NoteType;
  originalInvoiceId: number | null | undefined;
  noteReason: string | null | undefined;
  total: number;
  /** Set when re-checking an existing note, so it does not count against itself. */
  excludeNoteId?: number;
  /** Decision 8 — a DEBIT note's substance, the day the price changed, and the note's own date. */
  chargeSubstance?: string | null;
  chargeEventDate?: string | null;
  noteDate?: string | null;
}): Promise<void> {
  const label = LABEL[input.documentType];

  if (!input.originalInvoiceId) {
    throw new BusinessRuleError(400, {
      code: "note_original_required",
      error: `A ${label} must reference the invoice it corrects.`,
    });
  }

  // BR-KSA-17 requires the reason (KSA-10) on every note. Enforced here so it is
  // a 400 at entry rather than a ZATCA rejection at submission.
  if (!input.noteReason?.trim()) {
    throw new BusinessRuleError(400, {
      code: "note_reason_required",
      error:
        `A ${label} must state why it is being issued (ZATCA rule BR-KSA-17). ` +
        `For example: "Goods returned" or "Price correction".`,
    });
  }

  const [original] = await invoicesRepository.findById(input.originalInvoiceId);
  if (!original) {
    throw new NotFoundError(`The invoice this ${label} refers to does not exist.`);
  }

  // A note against a draft is meaningless: the original is not in the books, has
  // no hash and no ICV, so there is nothing to correct. Edit the draft instead.
  if (!ISSUED_STATUSES.includes(original.status)) {
    throw new BusinessRuleError(409, {
      code: "note_original_not_issued",
      error:
        `Invoice ${original.invoiceNumber} has not been issued yet (status: ${original.status}), ` +
        `so it cannot be corrected by a ${label}. Edit the draft instead.`,
    });
  }

  assertNotReversedOpening(original, `Invoice ${original.invoiceNumber}`, `corrected by a ${label}`);

  // 2026-09-22 (accountant answer 3; Batch 1C pack §17): a credit note against
  // an invoice the PREVIOUS solution issued is issued HERE, electronically,
  // through Fatoora — never a manual route — naming the original's own
  // number (BT-25, Art. 54(4)). It is gated on the original's e-invoicing
  // identity being STATED (cleared / reported with the UUID, or
  // pre_einvoicing); an unstated identity refuses by name, so nothing is
  // minted against a document nobody has described. A reversed original
  // (Policy C history) is refused earlier, at the write boundary every
  // opening-row act shares (openingReversed.ts → opening_item_reversed).
  if (original.isOpening) {
    const eligibility = await migrationCorrectionService.noteEligibility(original);
    if (!eligibility.eligible) {
      throw new BusinessRuleError(409, { code: eligibility.code, error: eligibility.error, field: "originalInvoiceId" });
    }
  }

  if (isNoteType(original.documentType)) {
    throw new BusinessRuleError(409, {
      code: "note_original_is_note",
      error: `A ${label} must reference an invoice, not another note.`,
    });
  }

  // ── Phase 18 G3 (owner decision 3, 2026-10-27): a RECOVERY is never corrected by an ordinary note ──
  // An Art. 40(9) recovery invoice carries no receivable (the debt was written off) and folds the receipt
  // into its own issue entry, so an ordinary note would credit or charge a sale that is not there. Its
  // correction adjusts the allocation, the receivable and the VAT together — a controlled workflow that
  // is a design item, never automated. The G59 refusal (unapplying its receipt) stands beside this one.
  if (isRecoveryInvoiceType(original.documentType)) {
    throw new BusinessRuleError(409, {
      code: "note_original_is_recovery_invoice",
      error:
        `${original.invoiceNumber} is a tax invoice for a recovered bad debt (VAT Art. 40(9)). It is never corrected with an ordinary ${label}: ` +
        `a recovery's correction adjusts its receipt, the receivable and the VAT together, and that controlled correction is not available yet. ` +
        `Record the facts and take advice; nothing was created.`,
      field: "originalInvoiceId",
    });
  }

  // ── AP-3: the two doors are kept apart by TYPE ─────────────────────────
  // An ordinary credit/debit note against an ADVANCE TAX INVOICE is refused:
  // its entry would post Dr Sales / Dr VAT / Cr AR against a document that
  // carried neither (and its excess would become a Model C credit balance
  // over cash that is still the receipt's deposit). The controlled path is
  // `advance_credit_note` (advanceInvoicesService.creditAdvance), whose entry
  // is E5 — Dr VAT Payable / Cr Customer deposits — and which unlocks the
  // Batch 1B deposit refund for exactly the credited part.
  if (input.documentType !== ADVANCE_CREDIT_NOTE_TYPE && isAdvanceInvoiceType(original.documentType)) {
    throw new BusinessRuleError(409, {
      code: "note_original_is_advance_invoice",
      error:
        `${original.invoiceNumber} is an advance tax invoice. It is cancelled with a credit note against the advance (POST /invoices/${original.id}/advance-credit-notes), ` +
        `which returns the advance's VAT to the deposit and lets the receipt be refunded — not with an ordinary ${label}.`,
      field: "originalInvoiceId",
    });
  }
  if (input.documentType === ADVANCE_CREDIT_NOTE_TYPE) {
    if (!isAdvanceInvoiceType(original.documentType)) {
      throw new BusinessRuleError(409, {
        code: "advance_credit_note_original_not_advance",
        error: `${original.invoiceNumber} is not an advance tax invoice; a ${label} can only reference an advance tax invoice (type 386). Use an ordinary credit note.`,
        field: "originalInvoiceId",
      });
    }
    // The cap is the 386's OPEN part — issued total − adjusted by issued final
    // invoices − already credited. An adjusted part was settled by a final
    // invoice and is corrected by a note on THAT invoice, never here.
    const bal = (await advanceInvoicesRepository.openBalances([original.id], input.excludeNoteId)).get(original.id) ?? { adjusted: 0, credited: 0, open: money(original.total) };
    if (input.total > bal.open + 0.005) {
      throw new BusinessRuleError(409, {
        code: "advance_credit_note_exceeds_open",
        error:
          `This credit note is ${fmt(input.total)} but only ${fmt(bal.open)} of advance tax invoice ${original.invoiceNumber} is still open ` +
          `(issued ${fmt(money(original.total))}, applied on final invoices ${fmt(bal.adjusted)}, already credited ${fmt(bal.credited)}). ` +
          `An applied part is corrected by a credit note on the final invoice that applied it.`,
        openAmount: fmt(bal.open),
        adjustedAmount: fmt(bal.adjusted),
        creditedAmount: fmt(bal.credited),
        field: "total",
      });
    }
    return;
  }

  // ── Decision 8: what a debit note's extra charge IS, and when the price changed ──
  // After every refusal about the ORIGINAL, so those keep their order and meaning.
  if (input.documentType === "debit_note") {
    assertChargeSubstance(input.chargeSubstance);
    assertChargeEventDate(input.chargeEventDate, original, input.noteDate);
  }

  // ── Over-crediting guard ────────────────────────────────────────────────
  // Only credit notes are capped: they give value back, so crediting more than
  // was invoiced is a real tax exposure. A DEBIT note adds charges and has no
  // equivalent ceiling.
  if (input.documentType === "credit_note") {
    const existing = await invoicesRepository.notesAgainst(original.id, "credit_note");
    const alreadyCredited = existing
      .filter((n) => n.id !== input.excludeNoteId)
      .reduce((sum, n) => sum + money(n.total), 0);

    const originalTotal = money(original.total);
    const remaining = originalTotal - alreadyCredited;

    if (input.total > remaining + 0.005) {
      throw new BusinessRuleError(409, {
        code: "note_over_credit",
        error:
          `This credit note is ${fmt(input.total)} but only ${fmt(remaining)} remains creditable ` +
          `against invoice ${original.invoiceNumber} (invoice total ${fmt(originalTotal)}, ` +
          `already credited ${fmt(alreadyCredited)}).`,
        originalTotal: fmt(originalTotal),
        alreadyCredited: fmt(alreadyCredited),
        remaining: fmt(remaining),
      });
    }
  }
}
