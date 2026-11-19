/**
 * Walk L3/L5 (2026-11-16 walk; the work package's included walk items, owner 2026-11-17): the labels the Users page
 * and the audit trail printed raw — a role, an invitation's status, an audit action, an audited record's type — and the
 * bank-detail line that read "none → none", each in the reader's language.
 */
type T = (en: string, ar: string) => string;

/** A membership role, in the Users page's own words (its role pickers already say these). */
export function roleName(role: string, t: T): string {
  const names: Record<string, [string, string]> = {
    viewer: ["Viewer", "مشاهد"],
    bookkeeper: ["Bookkeeper", "ماسك دفاتر"],
    accountant: ["Accountant", "محاسب"],
    admin: ["Admin", "مسؤول"],
  };
  const n = names[role];
  return n ? t(n[0], n[1]) : role;
}

/** An invitation's status. */
export function invitationStatusLabel(status: string, t: T): string {
  const names: Record<string, [string, string]> = {
    pending: ["Pending", "قيد الانتظار"],
    accepted: ["Accepted", "مقبولة"],
    revoked: ["Revoked", "ملغاة"],
    expired: ["Expired", "منتهية"],
  };
  const n = names[status];
  return n ? t(n[0], n[1]) : status;
}

/**
 * 🔴 The audit trail's ACTIONS and RECORD TYPES — every one the API writes (swept 2026-11-19: `auditService.<verb>("…"`,
 * `entityType: "…"` and `action: "…"` across apps/api/src, tests excluded), plus `payroll`, which older rows carry.
 * A value not listed here still reads in the reader's language: an Arabic word, with the raw name beside it.
 */
const AUDIT_ACTIONS: Record<string, [string, string]> = {
  create: ["Created", "إنشاء"],
  update: ["Updated", "تعديل"],
  delete: ["Deleted", "حذف"],
  submit: ["Submitted", "تقديم للاعتماد"],
  approve: ["Approved", "اعتماد"],
  reject: ["Rejected", "رفض"],
  send_back: ["Sent back", "إعادة للتعديل"],
  export: ["Exported", "تصدير"],
  allocate: ["Allocated", "تخصيص"],
  unallocate: ["Allocation undone", "إلغاء التخصيص"],
  reverse_allocation: ["Allocation reversed", "عكس التخصيص"],
  apply: ["Applied", "تطبيق"],
  cancel: ["Cancelled", "إلغاء"],
  cash_cutover: ["Cash cut-over", "تحويل النقد إلى حسابات البنوك"],
  classify: ["Classified", "تصنيف"],
  complete: ["Completed", "إكمال"],
  evidence: ["Evidence recorded", "تسجيل إثبات"],
  force_override: ["Overridden", "تجاوز"],
  input_vat_claimed: ["Input VAT claimed", "مطالبة بضريبة المدخلات"],
  match: ["Matched", "مطابقة"],
  match_override: ["Matched by override", "مطابقة بتجاوز"],
  unmatch: ["Match undone", "إلغاء المطابقة"],
  onboard: ["Onboarded", "تسجيل لدى الهيئة"],
  opening_identity_record: ["Opening identity recorded", "تسجيل الهوية الافتتاحية"],
  opening_item_correct: ["Opening item corrected", "تصحيح بند افتتاحي"],
  opening_vat_declaration_record: ["Opening VAT declaration recorded", "تسجيل إقرار ضريبي افتتاحي"],
  pay: ["Paid", "سداد"],
  pay_gosi: ["GOSI paid", "سداد التأمينات الاجتماعية"],
  post: ["Posted", "ترحيل"],
  recognise: ["Recognised", "إثبات"],
  refund: ["Refunded", "رد مبلغ"],
  reopen: ["Reopened", "إعادة فتح"],
  reverse: ["Reversed", "عكس"],
  revoke: ["Revoked", "إلغاء"],
  settle: ["Settled", "تسوية"],
  supersede: ["Superseded", "استبدال"],
  unapplied: ["Left unapplied", "غير مخصّص"],
  vat_figures_confirmed: ["VAT figures confirmed", "تأكيد أرقام الضريبة"],
  wht_correct: ["Withholding corrected", "تصحيح الاستقطاع"],
  write_off: ["Written off", "شطب"],
  migration_advances_import: ["Migration: advances imported", "الترحيل: استيراد الدفعات المقدمة"],
  migration_assets_import: ["Migration: assets imported", "الترحيل: استيراد الأصول"],
  migration_batch_commit: ["Migration committed", "اعتماد الترحيل"],
  migration_batch_create: ["Migration created", "إنشاء دفعة ترحيل"],
  migration_batch_discard: ["Migration discarded", "استبعاد دفعة ترحيل"],
  migration_batch_reverse: ["Migration reversed", "عكس الترحيل"],
  migration_batch_update: ["Migration updated", "تعديل دفعة ترحيل"],
  migration_batch_validate: ["Migration checked", "التحقق من الترحيل"],
  migration_chart_decide: ["Migration: account decided", "الترحيل: تحديد حساب"],
  migration_chart_import: ["Migration: chart imported", "الترحيل: استيراد دليل الحسابات"],
  migration_open_items_import: ["Migration: open items imported", "الترحيل: استيراد البنود المفتوحة"],
  migration_parties_import: ["Migration: parties imported", "الترحيل: استيراد الأطراف"],
  migration_party_decide: ["Migration: party decided", "الترحيل: تحديد طرف"],
};

const AUDIT_ENTITIES: Record<string, [string, string]> = {
  invoice: ["Invoice", "فاتورة"],
  bill: ["Supplier bill", "فاتورة مورد"],
  credit_note: ["Credit note", "إشعار دائن"],
  supplier_credit_note: ["Supplier credit note", "إشعار دائن من مورد"],
  invoice_rejection: ["Invoice rejection", "رفض فاتورة"],
  journal_entry: ["Journal entry", "قيد يومية"],
  payroll: ["Payroll run", "مسير رواتب"],
  payroll_run: ["Payroll run", "مسير رواتب"],
  transaction: ["Bank transaction", "حركة بنكية"],
  bank_statement: ["Bank statement", "كشف بنكي"],
  bank_statement_link: ["Statement link", "ربط كشف بنكي"],
  statement_match: ["Statement match", "مطابقة كشف"],
  statement_authorisation: ["Statement authorisation", "اعتماد قائمة"],
  bank_reconciliation: ["Bank reconciliation", "تسوية بنكية"],
  bank_transfer: ["Transfer between accounts", "تحويل بين الحسابات"],
  bank_account: ["Bank account", "حساب بنكي"],
  bank_detail_change_request: ["Bank-detail change", "تغيير بيانات بنكية"],
  customer: ["Customer", "عميل"],
  vendor: ["Supplier", "مورد"],
  product: ["Product", "منتج"],
  employee: ["Employee", "موظف"],
  payment: ["Customer receipt", "سند قبض"],
  payment_allocation: ["Receipt allocation", "تخصيص سند قبض"],
  customer_refund: ["Refund to a customer", "رد مبلغ لعميل"],
  supplier_payment: ["Supplier payment", "دفعة لمورد"],
  supplier_payment_allocation: ["Supplier payment allocation", "تخصيص دفعة مورد"],
  supplier_refund: ["Refund from a supplier", "استرداد من مورد"],
  supplier_deposit_forfeiture: ["Supplier deposit forfeited", "مصادرة تأمين لدى مورد"],
  scheduled_payment: ["Payment plan", "خطة دفع"],
  asset: ["Asset", "أصل"],
  asset_category: ["Asset class", "فئة أصول"],
  asset_disposal: ["Asset disposal", "استبعاد أصل"],
  asset_vat_use_record: ["Asset VAT use", "استخدام ضريبي لأصل"],
  asset_tax_pool_declaration: ["Asset tax pool", "مجمع ضريبي للأصول"],
  recognition_schedule: ["Recognition schedule", "جدول إثبات"],
  budget: ["Budget", "موازنة"],
  budget_version: ["Budget version", "نسخة موازنة"],
  budget_version_lines: ["Budget lines", "بنود موازنة"],
  category: ["Account", "حساب"],
  quotation: ["Quotation", "عرض سعر"],
  quotation_conversion: ["Quotation converted", "تحويل عرض سعر"],
  purchase_order: ["Purchase order", "أمر شراء"],
  purchase_order_conversion: ["Purchase order converted", "تحويل أمر شراء"],
  period_lock: ["Closed month", "شهر مُقفل"],
  company: ["Company", "الشركة"],
  company_control_settings: ["Control settings", "إعدادات الضوابط"],
  recurring_rule: ["Recurring rule", "قاعدة متكررة"],
  report_export: ["Report export", "تصدير تقرير"],
  finding: ["Finding", "ملاحظة"],
  findings_run: ["Findings run", "فحص الملاحظات"],
  finding_schedule: ["Findings schedule", "جدول فحص الملاحظات"],
  captured_document: ["Captured document", "مستند ملتقط"],
  grounded_answer: ["Assistant answer", "إجابة المساعد"],
  treasury_settings: ["Treasury settings", "إعدادات الخزينة"],
  treasury_forecast_entry: ["Treasury assumption", "افتراض في الخزينة"],
  tax_computation: ["Tax computation", "احتساب ضريبي"],
  tax_computation_version: ["Tax computation version", "نسخة احتساب ضريبي"],
  tax_adjustment: ["Tax adjustment", "تعديل ضريبي"],
  vat_return_filing: ["VAT return filing", "تقديم إقرار ضريبة القيمة المضافة"],
  vat_correction: ["VAT correction", "تصحيح ضريبة القيمة المضافة"],
  zakat_account_classification: ["Zakat account classification", "تصنيف حساب للزكاة"],
  zakat_income_tax_filing: ["Zakat or income tax filing", "إقرار زكاة أو ضريبة دخل"],
  wht_treaty_relief: ["Treaty relief", "إعفاء بموجب اتفاقية"],
  wht_remittance: ["Withholding remittance", "توريد ضريبة الاستقطاع"],
  wht_withholding: ["Withholding", "استقطاع"],
  wht_return: ["Withholding return", "إقرار الاستقطاع"],
  wht_return_filing: ["Withholding return filing", "تقديم إقرار الاستقطاع"],
  wht_refund_claim: ["Withholding refund claim", "مطالبة باسترداد الاستقطاع"],
  wht_refund_claim_event: ["Refund claim step", "خطوة في مطالبة الاسترداد"],
  wht_instalment_request: ["Instalment request", "طلب تقسيط"],
  wht_instalment_request_event: ["Instalment request step", "خطوة في طلب التقسيط"],
  wht_contract: ["Withholding contract", "عقد استقطاع"],
  zatca_credential: ["ZATCA credential", "شهادة هيئة الزكاة والضريبة والجمارك"],
  migration_batch: ["Migration batch", "دفعة ترحيل"],
  migration_party: ["Migration party", "طرف في الترحيل"],
  migration_chart_row: ["Migration account row", "حساب في الترحيل"],
};

/** Every record type the audit trail can be filtered by — the ones the API writes, and older rows' `payroll`. */
export const AUDIT_ENTITY_TYPES: readonly string[] = Object.keys(AUDIT_ENTITIES);
/** Every action the audit trail can be filtered by. */
export const AUDIT_ACTION_TYPES: readonly string[] = Object.keys(AUDIT_ACTIONS);

/** What an audit-trail row records was done. */
export function auditActionLabel(action: string, t: T): string {
  const n = AUDIT_ACTIONS[action];
  return n ? t(n[0], n[1]) : t(action.replace(/_/g, " "), `إجراء: ${action}`);
}

/** The type of record an audit-trail row is about. */
export function auditEntityLabel(entityType: string, t: T): string {
  const n = AUDIT_ENTITIES[entityType];
  return n ? t(n[0], n[1]) : t(entityType.replace(/_/g, " "), `سجل: ${entityType}`);
}

/** A bank-detail change's IBANs: an empty one is said, never printed as "none → none". */
export function ibanChangeText(before: string | null, after: string | null, t: T): string {
  if (before == null && after == null) return t("No IBAN on either side of the change", "لا يوجد آيبان قبل التغيير ولا بعده");
  const one = (v: string | null) => v ?? t("no IBAN", "بلا آيبان");
  return `${one(before)} → ${one(after)}`;
}
