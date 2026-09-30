/**
 * Phase 13B S1 — the refusals an opening payable's VAT history can produce, as
 * a TITLE in both languages keyed on the structured CODE (CLAUDE.md §3:
 * "explain a refusal … key the UI on the structured CODE, so rewording copy
 * cannot break it"). The server's own sentence stays the description — it
 * names the document and the figures; the title here says what to do next.
 *
 * One map for both surfaces: the credit-note posting (Supplier credit notes,
 * Approvals) and the declaration (Migration → AP open items).
 */
type T = (en: string, ar: string) => string;

const TITLES: Record<string, [string, string]> = {
  // a credit note against an opening payable
  supplier_note_evidence_missing: ["Attach the supplier's credit note first", "أرفق إشعار الدائن الصادر من المورّد أولًا"],
  input_vat_note_opening_undeclared: ["Declare the opening bill's VAT history first", "أعلِن أولًا تاريخ ضريبة الفاتورة الافتتاحية"],
  input_vat_note_transitional_supply: ["Not supported — a transitional-rate supply", "غير مدعوم — توريد بنسبة انتقالية"],
  input_vat_note_multistate: ["Not supported yet — the bill's VAT is split", "غير مدعوم بعد — ضريبة الفاتورة مجزّأة"],
  input_vat_note_overpaid_reversed: ["Not supported yet — this note would settle a reversed payable", "غير مدعوم بعد — هذا الإشعار يسوّي ذمة معكوسة ضريبتها"],
  input_vat_note_opening_reversed: ["This opening bill was reversed — record the note against the live bill", "هذه الفاتورة الافتتاحية معكوسة — سجّل الإشعار على الفاتورة القائمة"],
  credit_note_exceeds_invoice_vat: ["More VAT than the bill has left", "ضريبة أكثر مما تبقّى على الفاتورة"],
  // the declaration
  opening_vat_declaration_evidence_missing: ["Attach the evidence this history needs", "أرفق الأدلة التي يتطلبها هذا التاريخ"],
  opening_vat_declaration_evidence_reused: ["Each kind of evidence needs its own document", "كل نوع من الأدلة يحتاج مستندًا خاصًا به"],
  opening_vat_declaration_exists: ["Already declared — a declaration is permanent", "مُعلن مسبقًا — الإعلان دائم"],
  opening_vat_declaration_state_not_enabled: ["This history is not supported yet", "هذا التاريخ غير مدعوم بعد"],
  opening_vat_declaration_contradicts_staging: ["It contradicts the migrated figures", "يتعارض مع الأرقام المرحَّلة"],
  opening_vat_declaration_exceeds_document: ["More VAT than the document could carry", "ضريبة أكثر مما يحتمله المستند"],
  opening_vat_declaration_40_10_not_established: ["A deduction here must have been reversed", "يجب أن يكون الخصم هنا قد عُكس"],
  opening_vat_declaration_location_required: ["Say where the reversed VAT was carried", "حدّد أين حُمِّلت الضريبة المعكوسة"],
  opening_vat_declaration_premise_not_affirmed: ["Confirm the VAT was carried in cost", "أكّد أن الضريبة حُمِّلت على التكلفة"],
  opening_vat_declaration_period_required: ["A period is missing", "الفترة ناقصة"],
  opening_vat_declaration_period_out_of_range: ["The period is outside the document's life", "الفترة خارج عمر المستند"],
  opening_vat_declaration_amount_required: ["State the historical VAT", "اذكر الضريبة التاريخية"],
  opening_vat_declaration_rate_required: ["State the historical VAT rate", "اذكر نسبة الضريبة التاريخية"],
  capture_unavailable: ["An evidence file is no longer available — upload it again", "ملف دليل لم يعد متاحًا — ارفعه مجددًا"],
  opening_item_not_live: ["This migrated item is no longer live", "هذا البند المرحَّل لم يعد قائمًا"],
  opening_item_vat_declared: ["Its VAT history is declared — the amount cannot be corrected", "تاريخ ضريبته مُعلن — لا يمكن تصحيح المبلغ"],
};

/** The bilingual title for an S1 refusal code, or null when the code is not one of these. */
export function openingVatRefusalTitle(code: string | undefined | null, t: T): string | null {
  const pair = code ? TITLES[code] : undefined;
  return pair ? t(pair[0], pair[1]) : null;
}

/**
 * The code and the server's WHOLE sentence from either error class: `apiFetch`'s
 * (`@/lib/api`, `.code` / `.body`) or the generated client's (`custom-fetch`,
 * `.data`) — whose `.message` is "HTTP 422 …: " plus the sentence cut at 300
 * characters, so the body is read instead of the message.
 */
export function refusalOf(e: unknown): { code: string | undefined; words: string } {
  const err = e as { code?: string; body?: { code?: string; error?: string }; data?: { code?: string; error?: string }; message?: string };
  const code = err?.code ?? err?.body?.code ?? err?.data?.code;
  const words = err?.body?.error ?? err?.data?.error ?? err?.message ?? String(e);
  return { code, words };
}
