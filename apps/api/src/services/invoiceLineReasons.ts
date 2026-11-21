/**
 * 🔴 A ZERO-RATED, EXEMPT OR OUT-OF-SCOPE INVOICE LINE CARRIES ITS REASON (owner, 2026-11-21).
 *
 * The reason is ZATCA's code (BT-121) from its list (@workspace/shared `vatExemptionReasons`, XML Implementation
 * Standard v1.2 §11.2.4) and its text (BT-120). Until 2026-11-21 the invoice API's line input had no such field, so the
 * request validator dropped it: an onboarded company was refused at issuance for every Z/E/O line, and one not
 * onboarded issued the line without its reason.
 *
 *   - at CREATE and EDIT (`normalizeLineReason`): a code must be on the list and belong to the line's category; a
 *     standard-rated line takes none. A coded reason stores ZATCA's own English text; VATEX-SA-OOS keeps the
 *     taxpayer's text. A draft may still lack its reason.
 *   - at APPROVAL (`assertLineReasons`), for every company, before the ICV: each Z/E/O line must name its reason (an
 *     OOS line its text too), refused by name in both languages — so nothing is issued without it.
 */
import { exemptionReason, isExemptionCategory } from "@workspace/shared";
import { BusinessRuleError } from "../lib/errors";

type LineLike = { vatRate?: unknown; taxCategoryCode?: string | null; taxExemptionReasonCode?: unknown; taxExemptionReasonText?: unknown };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const categoryOf = (it: LineLike): string | null => it.taxCategoryCode ?? (Number(it.vatRate ?? 15) > 0 ? "S" : null);

/** The reason fields to store for one line, or a named 422. */
export function normalizeLineReason(it: LineLike, index: number): { taxExemptionReasonCode: string | null; taxExemptionReasonText: string | null } {
  const category = categoryOf(it);
  const code = str(it.taxExemptionReasonCode);
  const text = str(it.taxExemptionReasonText);
  if (!code && !text) return { taxExemptionReasonCode: null, taxExemptionReasonText: null };
  const line = index + 1;
  if (!isExemptionCategory(category)) {
    throw new BusinessRuleError(422, {
      code: "line_exemption_reason_mismatch",
      error: `Line ${line} is standard-rated, so it takes no exemption reason. Choose the zero-rated, exempt or out-of-scope category first.`,
      errorAr: `البند ${line} خاضع للنسبة الأساسية، فلا يُذكر له سبب إعفاء. اختر فئة الخاضع لنسبة الصفر أو المعفى أو غير الخاضع أولاً.`,
      line,
    });
  }
  if (!code) return { taxExemptionReasonCode: null, taxExemptionReasonText: text };
  const reason = exemptionReason(code);
  if (!reason) {
    throw new BusinessRuleError(422, {
      code: "line_exemption_reason_invalid",
      error: `Line ${line}: "${code}" is not on ZATCA's list of exemption reason codes.`,
      errorAr: `البند ${line}: الرمز "${code}" ليس ضمن قائمة رموز أسباب الإعفاء لدى هيئة الزكاة والضريبة والجمارك.`,
      line,
    });
  }
  if (reason.category !== category) {
    throw new BusinessRuleError(422, {
      code: "line_exemption_reason_mismatch",
      error: `Line ${line}: ${code} is a reason for category ${reason.category}, but the line is category ${category}.`,
      errorAr: `البند ${line}: الرمز ${code} سبب لفئة ${reason.category}، والبند من فئة ${category}.`,
      line,
    });
  }
  return { taxExemptionReasonCode: code, taxExemptionReasonText: reason.freeText ? text : reason.en };
}

/** Before issuance, for every company: each Z/E/O line names its reason (an OOS line its text too). */
export function assertLineReasons(items: ReadonlyArray<LineLike>): void {
  items.forEach((it, i) => {
    const category = categoryOf(it);
    if (!isExemptionCategory(category)) return;
    const reason = exemptionReason(str(it.taxExemptionReasonCode));
    const complete = reason && reason.category === category && (!reason.freeText || str(it.taxExemptionReasonText));
    if (complete) return;
    const line = i + 1;
    throw new BusinessRuleError(422, {
      code: "line_exemption_reason_missing",
      error: `Line ${line} is ${category === "Z" ? "zero-rated" : category === "E" ? "exempt" : "out of scope"} and needs its reason from ZATCA's list${category === "O" ? ", with your own explanation" : ""} before it can be approved.`,
      errorAr: `البند ${line} ${category === "Z" ? "خاضع لنسبة الصفر" : category === "E" ? "معفى" : "غير خاضع للضريبة"} ويحتاج سببه من قائمة هيئة الزكاة والضريبة والجمارك${category === "O" ? " مع شرحك الخاص" : ""} قبل اعتماده.`,
      line,
    });
  });
}
