/**
 * 🔴 THE INVOICE FORM'S LINES, AND THE REQUEST IT SENDS FOR THEM — ONE PURE FUNCTION (2026-11-21).
 *
 * Each line states its ZATCA VAT category (S standard, Z zero-rated, E exempt, O out of scope). A Z/E/O line is at 0%
 * and names its reason from ZATCA's list (@workspace/shared `vatExemptionReasons`); an out-of-scope line adds the
 * taxpayer's own text. The server checks the reason when the draft is saved and requires it before approval.
 *
 * `invoiceLinesBody` is the ONLY place the form turns its lines into the request's `items`: the create and the edit both
 * call it, and the live ZATCA verification pass (apps/api/src/tests/zatca-br-ksa-49-live.test.ts) builds its request
 * with this same function — so the live pass sends the form's own request, not a hand-built one. It lives here, not in
 * apps/web, so the API's tests can import it (one definition; the web page apps/web/src/pages/Invoices.tsx uses it).
 */
import { DEFAULT_VAT_RATE } from "./saudi";
import { exemptionReason, isExemptionCategory } from "./vatExemptionReasons";

export type LineCategory = "S" | "Z" | "E" | "O" | "";

export interface InvoiceFormLine {
  description: string;
  descriptionAr: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
  /** "" only for a stored 0% line whose category was never stated: the form asks for one. */
  taxCategoryCode: LineCategory;
  taxExemptionReasonCode: string;
  taxExemptionReasonText: string;
}

/** One definition of a fresh line — standard-rated at the default rate from @workspace/shared, never a literal. */
export const emptyInvoiceLine = (): InvoiceFormLine => ({
  description: "", descriptionAr: "", quantity: "1", unitPrice: "", vatRate: String(DEFAULT_VAT_RATE),
  taxCategoryCode: "S", taxExemptionReasonCode: "", taxExemptionReasonText: "",
});

/** A stored line, as the form edits it. */
export function invoiceLineFromItem(i: Record<string, any>): InvoiceFormLine {
  const vatRate = Number(i.vatRate ?? DEFAULT_VAT_RATE);
  const category = (i.taxCategoryCode ?? (vatRate > 0 ? "S" : "")) as LineCategory;
  return {
    description: i.description ?? "",
    // the stored default "(not yet translated)" is a sentinel, not a value — an empty input is the honest prefill
    descriptionAr: i.descriptionAr === "(not yet translated)" ? "" : (i.descriptionAr ?? ""),
    quantity: String(i.quantity ?? 1),
    unitPrice: String(i.unitPrice ?? ""),
    vatRate: String(vatRate),
    taxCategoryCode: category,
    taxExemptionReasonCode: i.taxExemptionReasonCode ?? "",
    taxExemptionReasonText: exemptionReason(i.taxExemptionReasonCode)?.freeText ? (i.taxExemptionReasonText ?? "") : "",
  };
}

/** Changing a line's category: a Z/E/O line is at 0% and keeps a reason only if it belongs to the new category. */
export function withCategory(line: InvoiceFormLine, category: LineCategory): InvoiceFormLine {
  const zeo = isExemptionCategory(category);
  const keep = zeo && exemptionReason(line.taxExemptionReasonCode)?.category === category;
  return {
    ...line,
    taxCategoryCode: category,
    vatRate: zeo ? "0" : category === "S" && Number(line.vatRate) === 0 ? String(DEFAULT_VAT_RATE) : line.vatRate,
    taxExemptionReasonCode: keep ? line.taxExemptionReasonCode : category === "O" ? "VATEX-SA-OOS" : "",
    taxExemptionReasonText: keep || category === "O" ? line.taxExemptionReasonText : "",
  };
}

/** The request's `items`, from the form's lines — the create and the edit both send exactly this. */
export function invoiceLinesBody(lines: InvoiceFormLine[]) {
  return lines
    .filter((l) => l.description.trim() && Number(l.unitPrice) > 0)
    .map((l) => {
      const category = l.taxCategoryCode || null;
      const zeo = isExemptionCategory(category);
      const reason = zeo ? exemptionReason(l.taxExemptionReasonCode) : undefined;
      return {
        description: l.description.trim(),
        ...(l.descriptionAr.trim() ? { descriptionAr: l.descriptionAr.trim() } : {}),
        quantity: Number(l.quantity) || 1,
        unitPrice: Number(l.unitPrice),
        vatRate: zeo ? 0 : Number(l.vatRate) || 0,
        ...(category ? { taxCategoryCode: category } : {}),
        ...(reason ? { taxExemptionReasonCode: reason.code } : {}),
        ...(reason?.freeText && l.taxExemptionReasonText.trim() ? { taxExemptionReasonText: l.taxExemptionReasonText.trim() } : {}),
      };
    });
}
