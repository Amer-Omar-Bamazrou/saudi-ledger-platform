/**
 * Batch 1C — Policy C (accountant A4, 2026-09-20; decision pack §16.12.1):
 * a REVERSED opening item is history. Nothing acts on it — it is not paid,
 * not allocated to, not credited, not refunded, not matched. Readers exclude
 * it through `repositories/openingReversal.ts`; WRITERS refuse it here, at
 * the existing eligibility checks, with one code the UI can key on.
 *
 * The database freezes the row too (`opening_reversed_frozen`, migration
 * 0081); this is the named refusal in front of that wall.
 */
import { BusinessRuleError } from "../../lib/errors";
import { isReservedOpeningNumber } from "@workspace/shared";

type Marked = { reversedAt?: Date | string | null; isOpening?: boolean | null };

export const isReversedOpening = (row: Marked): boolean => row.reversedAt != null;

export function assertNotReversedOpening(row: Marked, label: string, act: string): void {
  if (!isReversedOpening(row)) return;
  throw new BusinessRuleError(409, {
    code: "opening_item_reversed",
    error: `${label} is an opening item that the migration reversed; it is history and cannot be ${act}. The corrected migration's replacement item is the one to act on.`,
    field: "id",
  });
}

/**
 * `OPEN-<batch>-<seq>` is the number of a migration REPLACEMENT item and
 * nothing else may carry it (migration 0081's CHECK refuses it beneath this).
 */
export function assertNotReservedOpeningNumber(value: unknown, field: "invoiceNumber" | "billNumber" | "documentNumber"): void {
  const s = String(value ?? "").trim();
  if (!s || !isReservedOpeningNumber(s)) return;
  throw new BusinessRuleError(422, {
    code: "reserved_document_number",
    error: `${s} has the shape OPEN-<batch>-<n>, which is reserved for the replacement items of a corrected migration. Choose another number.`,
    field,
  });
}
