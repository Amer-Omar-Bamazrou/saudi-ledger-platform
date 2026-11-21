/**
 * 🔴 ZATCA'S TAX EXEMPTION (OR EXCEPTION) REASON CODES — ONCE (2026-11-21).
 *
 * Source: ZATCA, Electronic Invoice XML Implementation Standard, Version 1.2 (2023-05-19), §11.2.4 "VAT categories
 * code", pages 32–33 of 72 — the table "Tax exemption (or exception) reason code and text – specific to Saudi Arabia",
 * transcribed with its English and Arabic text as printed (the PDF is kept with the evidence of the change that added
 * this file). A zero-rated (Z), exempt (E) or out-of-scope (O) invoice line names one of these as BT-121, with its
 * text as BT-120; a standard-rated (S) line names none. VATEX-SA-OOS has no fixed text: "Reason is free text, to be
 * provided by the taxpayer on case to case basis."
 *
 * Read by the invoice API (a code must be on this list for its line's category; a coded reason stores ZATCA's own
 * English text) and by the invoice form (the reason is chosen from this list, in the reader's language).
 */
export type ExemptionCategory = "E" | "Z" | "O";

export interface VatExemptionReason {
  code: string;
  category: ExemptionCategory;
  en: string;
  ar: string;
  /** VATEX-SA-OOS: the text is the taxpayer's own, case by case. */
  freeText?: true;
}

export const VAT_EXEMPTION_REASONS: readonly VatExemptionReason[] = [
  { code: "VATEX-SA-29", category: "E", en: "Financial services mentioned in Article 29 of the VAT Regulations", ar: "الخدمات المالية" },
  { code: "VATEX-SA-29-7", category: "E", en: "Life insurance services mentioned in Article 29 of the VAT Regulations", ar: "عقد تأمين على الحياة" },
  { code: "VATEX-SA-30", category: "E", en: "Real estate transactions mentioned in Article 30 of the VAT Regulations", ar: "التوريدات العقارية المعفاة من الضريبة" },
  { code: "VATEX-SA-32", category: "Z", en: "Export of goods", ar: "صادرات السلع من المملكة" },
  { code: "VATEX-SA-33", category: "Z", en: "Export of services", ar: "صادرات الخدمات من المملكة" },
  { code: "VATEX-SA-34-1", category: "Z", en: "The international transport of Goods", ar: "النقل الدولي للسلع" },
  { code: "VATEX-SA-34-2", category: "Z", en: "international transport of passengers", ar: "النقل الدولي للركاب" },
  { code: "VATEX-SA-34-3", category: "Z", en: "services directly connected and incidental to a Supply of international passenger transport", ar: "الخدمات المرتبطة مباشرة أو عرضياً بتوريد النقل الدولي للركاب" },
  { code: "VATEX-SA-34-4", category: "Z", en: "Supply of a qualifying means of transport", ar: "توريد وسائل النقل المؤهلة" },
  { code: "VATEX-SA-34-5", category: "Z", en: "Any services relating to Goods or passenger transportation, as defined in article twenty five of these Regulations", ar: "الخدمات ذات الصلة بنقل السلع أو الركاب، وفقاً للتعريف الوارد بالمادة الخامسة والعشرين من اللائحة التنفيذية لنظام ضريبة القيمة المضافة" },
  { code: "VATEX-SA-35", category: "Z", en: "Medicines and medical equipment", ar: "الأدوية والمعدات الطبية" },
  { code: "VATEX-SA-36", category: "Z", en: "Qualifying metals", ar: "المعادن المؤهلة" },
  { code: "VATEX-SA-EDU", category: "Z", en: "Private education to citizen", ar: "الخدمات التعليمية الخاصة للمواطنين" },
  { code: "VATEX-SA-HEA", category: "Z", en: "Private healthcare to citizen", ar: "الخدمات الصحية الخاصة للمواطنين" },
  { code: "VATEX-SA-MLTRY", category: "Z", en: "supply of qualified military goods", ar: "توريد السلع العسكرية المؤهلة" },
  { code: "VATEX-SA-OOS", category: "O", en: "Reason is free text, to be provided by the taxpayer on case to case basis.", ar: "السبب يتم تزويده من قبل المكلف على أساس كل حالة على حدة", freeText: true },
];

export const EXEMPTION_CATEGORIES: readonly ExemptionCategory[] = ["Z", "E", "O"];

export function isExemptionCategory(category: string | null | undefined): category is ExemptionCategory {
  return category === "Z" || category === "E" || category === "O";
}

export function exemptionReason(code: string | null | undefined): VatExemptionReason | undefined {
  return VAT_EXEMPTION_REASONS.find((r) => r.code === code);
}

export function exemptionReasonsFor(category: string | null | undefined): VatExemptionReason[] {
  return VAT_EXEMPTION_REASONS.filter((r) => r.category === category);
}
