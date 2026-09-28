/**
 * Phase 13A — the words for the server's VAT-evidence verdict.
 *
 * 🔴 KEYED ON THE STRUCTURED CODE, never on the server's message (CLAUDE.md §3,
 * "explain a refusal"): rewording the server's English cannot break the page,
 * and every reason has an Arabic sentence. An unknown code falls back to the
 * server's own message rather than to nothing.
 */
type T = (en: string, ar: string) => string;

export type EvidenceStatus = "not_evaluated" | "not_required" | "evidenced" | "awaiting_evidence" | "not_deductible";
export interface EvidenceFlag { code: string; severity: string; message: string }

export const SUPPLIER_DOCUMENT_KINDS = ["tax_invoice", "simplified_tax_invoice", "no_tax_invoice"] as const;
export type SupplierDocumentKind = (typeof SUPPLIER_DOCUMENT_KINDS)[number];

export function kindLabel(kind: string | null | undefined, t: T): string {
  switch (kind) {
    case "tax_invoice": return t("Tax invoice", "فاتورة ضريبية");
    case "simplified_tax_invoice": return t("Simplified tax invoice", "فاتورة ضريبية مبسطة");
    case "no_tax_invoice": return t("Not a tax invoice (receipt, statement…)", "ليست فاتورة ضريبية (إيصال، كشف…)");
    default: return t("Not stated", "غير محدد");
  }
}

export function statusLabel(status: string | null | undefined, t: T): string {
  switch (status) {
    case "evidenced": return t("VAT evidenced", "ضريبة المدخلات مثبتة");
    case "awaiting_evidence": return t("Awaiting VAT evidence", "بانتظار إثبات الضريبة");
    case "not_deductible": return t("VAT not deductible", "الضريبة غير قابلة للخصم");
    case "not_required": return t("No VAT to evidence", "لا ضريبة تحتاج إثباتًا");
    default: return t("Not yet checked", "لم يُتحقق بعد");
  }
}

/**
 * Where a POSTED document's input VAT sits (accountant X1/X3/X5) — the
 * server's `inputVat.state`. Null on a draft.
 */
export function inputVatLabel(state: string | null | undefined, t: T): string | null {
  switch (state) {
    case "claimed": return t("Input VAT claimed", "ضريبة المدخلات مخصومة");
    case "awaiting_evidence": return t("VAT held — awaiting evidence", "الضريبة محتجزة — بانتظار الإثبات");
    case "not_deductible": return t("VAT in cost — not deductible", "الضريبة ضمن التكلفة — غير قابلة للخصم");
    default: return null;
  }
}

export function basisLabel(basis: string | null | undefined, t: T): string | null {
  switch (basis) {
    case "qr_signature_verified": return t("ZATCA QR, signature verified", "رمز الهيئة، التوقيع متحقق منه");
    case "qr_unsigned": return t("ZATCA QR (Phase 1, unsigned)", "رمز الهيئة (المرحلة الأولى، دون توقيع)");
    case "document_attached": return t("Document attached", "المستند مرفق");
    case "attested": return t("Stated by you — no document attached", "بإقرارك — دون مستند مرفق");
    default: return null;
  }
}

/** One reason, in both languages. */
export function flagText(f: EvidenceFlag, t: T): string {
  switch (f.code) {
    case "document_kind_not_stated": return t("State which supplier document you hold. Input VAT is claimed only on a tax invoice (VAT IR Art. 49(7)).", "حدّد مستند المورد الذي بحوزتك. لا تُخصم ضريبة المدخلات إلا بفاتورة ضريبية (المادة 49(7) من اللائحة).");
    case "no_tax_invoice": return t("This is not a tax invoice, so its VAT cannot be claimed. Obtain the supplier's tax invoice — the claim can then be made in the period you hold it (Art. 49(8)).", "هذا المستند ليس فاتورة ضريبية، فلا تُخصم ضريبته. احصل على الفاتورة الضريبية من المورد، ويمكن الخصم في الفترة التي تحوزها فيها (المادة 49(8)).");
    case "supplier_not_identified": return t("Choose the supplier — a tax invoice names the supplier and its VAT number.", "اختر المورد — تتضمن الفاتورة الضريبية اسم المورد ورقمه الضريبي.");
    case "supplier_vat_number_missing": return t("The supplier has no VAT number on record. Add it to the supplier.", "لا يوجد رقم ضريبي للمورد في السجل. أضفه إلى بيانات المورد.");
    case "supplier_vat_number_invalid": return t("The supplier's VAT number is not a valid Saudi VAT number (15 digits, starting and ending with 3).", "الرقم الضريبي للمورد غير صالح (15 رقمًا يبدأ وينتهي بالرقم 3).");
    case "supplier_invoice_number_missing": return t("Enter the supplier's invoice number — a tax invoice carries one (Art. 53(5)(b)).", "أدخل رقم فاتورة المورد — تحمل الفاتورة الضريبية رقمًا تسلسليًا (المادة 53(5)(ب)).");
    case "simplified_invoice_at_or_above_1000": return t("A simplified tax invoice to a business is only valid below SAR 1,000 (Art. 53(1)(c)). For this amount, obtain the supplier's full tax invoice.", "لا تصح الفاتورة الضريبية المبسطة لمنشأة إلا لتوريد أقل من 1,000 ريال (المادة 53(1)(ج)). لهذا المبلغ احصل على فاتورة ضريبية كاملة من المورد.");
    case "simplified_invoice_document_missing": return t("Attach the simplified tax invoice — its ZATCA QR code is how it is checked.", "أرفق الفاتورة الضريبية المبسطة — رمز الاستجابة الخاص بالهيئة هو وسيلة التحقق منها.");
    case "simplified_invoice_qr_missing": return t("No ZATCA QR code was read from the attached document. Rescan it so the QR is read, or obtain a full tax invoice.", "لم يُقرأ رمز استجابة للهيئة من المستند المرفق. أعد مسحه لقراءة الرمز، أو احصل على فاتورة ضريبية كاملة.");
    case "qr_unreadable": return t("The document's QR code could not be read as a ZATCA QR code.", "تعذّرت قراءة رمز المستند كرمز استجابة للهيئة.");
    case "qr_supplier_vat_mismatch": return t("The QR code names a different supplier VAT number from this bill's supplier.", "يحمل رمز الاستجابة رقمًا ضريبيًا لمورد مختلف عن مورد هذه الفاتورة.");
    case "qr_total_mismatch": return t("The QR code's total differs from this bill's total.", "يختلف إجمالي رمز الاستجابة عن إجمالي هذه الفاتورة.");
    case "qr_vat_mismatch": return t("The QR code's VAT differs from this bill's VAT.", "تختلف ضريبة رمز الاستجابة عن ضريبة هذه الفاتورة.");
    case "qr_date_differs": return t("The QR code's date differs from this bill's date.", "يختلف تاريخ رمز الاستجابة عن تاريخ هذه الفاتورة.");
    case "qr_signature_failed": return t("The invoice's ZATCA signature does NOT match its contents — it may have been altered. Obtain a genuine copy from the supplier.", "توقيع الهيئة على الفاتورة لا يطابق محتواها — قد تكون معدّلة. احصل على نسخة أصلية من المورد.");
    case "qr_signature_unchecked": return t("The invoice's ZATCA signature could not be checked.", "تعذّر التحقق من توقيع الهيئة على الفاتورة.");
    case "art50_blocked_expense_account": return t("This expense account is blocked input VAT (VAT IR Art. 50): the VAT is recorded as part of the expense's cost, and no input VAT is claimed.", "حساب المصروف هذا مصنّف ضريبة مدخلات محظورة الخصم (المادة 50 من اللائحة): تُسجَّل الضريبة ضمن تكلفة المصروف، ولا تُخصم ضريبة مدخلات.");
    case "vat_capitalised_fixed_asset": return t("A fixed asset with 0 % VAT recovery: its VAT is part of the asset's cost and no input VAT is claimed.", "أصل ثابت بنسبة استرداد 0%: تُضاف ضريبته إلى تكلفة الأصل ولا تُخصم ضريبة مدخلات.");
    case "vat_rate_not_standard": return t("The VAT is not 15 % of the subtotal — check the figures.", "الضريبة ليست 15% من المجموع قبل الضريبة — راجع الأرقام.");
    case "totals_do_not_reconcile": return t("The subtotal plus VAT does not equal the total.", "المجموع قبل الضريبة زائد الضريبة لا يساوي الإجمالي.");
    default: return f.message;
  }
}

export function duplicateReasonLabel(reason: string, t: T): string {
  switch (reason) {
    case "same_file": return t("The same file was captured before", "سبق التقاط الملف نفسه");
    case "same_supplier_invoice": return t("Same supplier and supplier invoice number", "المورد نفسه ورقم فاتورة المورد نفسه");
    case "same_supplier_date_amount": return t("Same supplier, date and total", "المورد نفسه والتاريخ والإجمالي نفسه");
    default: return reason;
  }
}

/** A reason's short name — the filter chips on the VAT-evidence list. */
export function flagShort(code: string, t: T): string {
  switch (code) {
    case "document_kind_not_stated": return t("Document not stated", "المستند غير محدد");
    case "no_tax_invoice": return t("Not a tax invoice", "ليست فاتورة ضريبية");
    case "supplier_not_identified": return t("No supplier", "دون مورد");
    case "supplier_vat_number_missing": return t("Supplier VAT number missing", "الرقم الضريبي للمورد مفقود");
    case "supplier_vat_number_invalid": return t("Supplier VAT number invalid", "الرقم الضريبي للمورد غير صالح");
    case "supplier_invoice_number_missing": return t("Invoice number missing", "رقم الفاتورة مفقود");
    case "simplified_invoice_at_or_above_1000": return t("Simplified invoice ≥ SAR 1,000", "فاتورة مبسطة ≥ 1,000 ريال");
    case "simplified_invoice_document_missing": return t("Simplified invoice not attached", "الفاتورة المبسطة غير مرفقة");
    case "simplified_invoice_qr_missing": return t("QR code not read", "لم يُقرأ رمز الاستجابة");
    case "qr_unreadable": return t("QR code unreadable", "رمز الاستجابة غير مقروء");
    case "qr_supplier_vat_mismatch": return t("QR: other supplier", "الرمز: مورد آخر");
    case "qr_total_mismatch": return t("QR: total differs", "الرمز: الإجمالي مختلف");
    case "qr_vat_mismatch": return t("QR: VAT differs", "الرمز: الضريبة مختلفة");
    case "qr_signature_failed": return t("Signature failed", "فشل التحقق من التوقيع");
    case "art50_blocked_expense_account": return t("Blocked VAT (Art. 50)", "ضريبة محظورة الخصم (المادة 50)");
    default: return code;
  }
}
