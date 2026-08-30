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

export const NOTE_TYPES = ["credit_note", "debit_note"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export function isNoteType(documentType: string | null | undefined): documentType is NoteType {
  return documentType === "credit_note" || documentType === "debit_note";
}

const LABEL: Record<NoteType, string> = {
  credit_note: "credit note",
  debit_note: "debit note",
};

/** States in which the ORIGINAL is a real, issued document a note can correct. */
// `overdue` was in this list and is not a status any writer produces; the list
// now names only values a row can actually hold.
const ISSUED_STATUSES = ["sent", "paid"];

const money = (v: unknown): number => Number(v ?? 0);
const fmt = (n: number): string => n.toFixed(2);

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

  if (isNoteType(original.documentType)) {
    throw new BusinessRuleError(409, {
      code: "note_original_is_note",
      error: `A ${label} must reference an invoice, not another note.`,
    });
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
