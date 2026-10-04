/**
 * Phase 16/17 — the bilingual labels of the tax and treasury vocabulary, keyed
 * by the API's own codes (never by English text, so rewording copy cannot
 * break a page — CLAUDE.md §3 "key the UI on the structured CODE").
 */
type T = (en: string, ar: string) => string;

/** IR Art. 63(1) natures (MoF Resolution 25). */
export const WHT_TYPE_LABEL: Record<string, [string, string]> = {
  rent: ["Rent", "إيجار"],
  royalty: ["Royalty or proceeds", "إتاوة أو ريع"],
  management_fee: ["Management fees", "أتعاب إدارة"],
  air_tickets_or_air_freight: ["Air tickets (departing KSA) or air freight", "تذاكر طيران دولية أو شحن جوي"],
  sea_freight: ["Sea freight", "شحن بحري"],
  intl_telecom: ["International telephone services", "خدمات اتصالات هاتفية دولية"],
  dividends: ["Dividends", "أرباح موزعة"],
  technical_consulting: ["Technical or consulting services", "خدمات فنية أو استشارية"],
  loan_returns: ["Loan returns", "عوائد قروض"],
  insurance_premiums: ["Insurance or reinsurance premium", "أقساط تأمين أو إعادة تأمين"],
  other_payments: ["Other payments (services not listed)", "دفعات أخرى (خدمات غير مدرجة)"],
};
export const WHT_TYPES = Object.keys(WHT_TYPE_LABEL);
export const whtTypeLabel = (code: string | null | undefined, t: T) => (code && WHT_TYPE_LABEL[code] ? t(...WHT_TYPE_LABEL[code]) : "—");

export const notSubjectLabel = (code: string | null | undefined, t: T) =>
  code === "goods" ? t("Payment for goods (IR Art. 63(7))", "دفعة مقابل سلع (المادة 63(7))")
    : code === "not_kingdom_source" ? t("Not from a source in the Kingdom (Art. 5)", "ليست من مصدر في المملكة (المادة 5)")
      : "—";

export const residencyLabel = (code: string | null | undefined, t: T) =>
  code === "resident" ? t("Resident", "مقيم") : code === "non_resident" ? t("Non-resident", "غير مقيم") : t("Not declared", "غير مُصرَّح");

export const whtMonthStatusLabel = (s: string, t: T) =>
  ({ nil: t("Nothing withheld", "لا استقطاع"), open: t("Month open", "الشهر جارٍ"), due: t("Due", "مستحق"), overdue: t("Overdue", "متأخر"), remitted: t("Remitted", "مُسدَّد") } as Record<string, string>)[s] ?? s;

/** The eight Zakat-base classes (1445H Regulations). */
export const ZAKAT_CLASS_LABEL: Record<string, [string, string]> = {
  equity: ["Equity (Art. 23(1))", "حقوق الملكية (المادة 23(1))"],
  provision_as_equity: ["Provision — treated as equity (Art. 24)", "مخصص — يعامل معاملة حقوق الملكية (المادة 24)"],
  noncurrent_liability: ["Non-current liability (Art. 29(1))", "التزام غير متداول (المادة 29(1))"],
  current_liability: ["Current liability (Art. 29(2))", "التزام متداول (المادة 29(2))"],
  noncurrent_asset_deducted: ["Non-current asset — deducted (Art. 26)", "أصل غير متداول — يُحسم (المادة 26)"],
  noncurrent_asset_not_deducted: ["Non-current asset — not deducted (Arts 42, 48)", "أصل غير متداول — لا يُحسم (المادتان 42 و48)"],
  current_asset_deducted: ["Current asset — deducted (Arts 26(6), 32, 52)", "أصل متداول — يُحسم (المواد 26(6) و32 و52)"],
  current_asset_not_deducted: ["Current asset — not deducted", "أصل متداول — لا يُحسم"],
  equity_computed: ["The result not yet allocated (Art. 23(1))", "النتيجة غير الموزعة (المادة 23(1))"],
};
export const zakatClassLabel = (code: string | null | undefined, t: T) => (code && ZAKAT_CLASS_LABEL[code] ? t(...ZAKAT_CLASS_LABEL[code]) : t("Not classified", "غير مصنَّف"));

export const computationStatusLabel = (s: string, t: T) =>
  ({ draft: t("Draft", "مسودة"), submitted: t("Submitted", "مقدَّم"), approved: t("Approved", "معتمد"), superseded: t("Superseded", "مستبدل") } as Record<string, string>)[s] ?? s;

/** Zakat working-paper step keys (zakatEngine) and income-tax step keys (incomeTaxEngine). */
export const STEP_LABEL: Record<string, [string, string]> = {
  equity: ["Equity and equivalents", "حقوق الملكية وما في حكمها"],
  provisions: ["Provisions as equity", "المخصصات معاملة حقوق الملكية"],
  liabilities_added: ["Liabilities added (within the deducted assets)", "الالتزامات المضافة (في حدود الأصول المحسومة)"],
  difference: ["Adjusted − book net profit", "صافي الربح المعدل − الدفتري"],
  deductions: ["Deductions", "الحسميات"],
  base_adjustments: ["Declared base adjustments", "تعديلات الوعاء المُقرَّة"],
  base_by_method: ["Base by the method", "الوعاء وفق الطريقة"],
  base_after_minimum: ["After the minimum base", "بعد الحد الأدنى للوعاء"],
  maximum: ["Maximum base", "الحد الأعلى للوعاء"],
  zakat_base: ["Zakat base", "الوعاء الزكوي"],
  zakat: ["Zakat", "الزكاة"],
  profit_before_taxes: ["Profit before Zakat and income tax", "الربح قبل الزكاة وضريبة الدخل"],
  book_depreciation: ["Add back: book depreciation", "يُضاف: الإهلاك الدفتري"],
  book_disposals: ["Reverse: book result on disposals", "يُعكس: نتيجة الاستبعاد الدفترية"],
  pool_deduction: ["Less: Art. 17 depreciation", "يُطرح: إهلاك المادة 17"],
  pool_excess: ["Add: Art. 17(g) excess of disposals", "يُضاف: فائض الاستبعاد المادة 17(ز)"],
  repairs_over_cap: ["Add: repairs above the Art. 18 cap", "يُضاف: إصلاحات تتجاوز سقف المادة 18"],
  declared_adjustments: ["Declared adjustments", "التعديلات المُقرَّة"],
  taxable_income: ["Taxable income", "الدخل الخاضع للضريبة"],
  losses_used: ["Less: losses carried forward (≤ 25 %)", "يُطرح: الخسائر المرحلة (حتى 25%)"],
  taxable_share: ["The non-Saudi share", "حصة غير السعوديين"],
  income_tax: ["Income tax (20 %)", "ضريبة الدخل (20%)"],
};
export const stepLabel = (key: string, t: T) => (STEP_LABEL[key] ? t(...STEP_LABEL[key]) : key.replace(/_/g, " "));

/**
 * A computation's blockers, keyed by the server's CODE (the server's own
 * sentence is English and stays visible beside this — the code decides the
 * words, so rewording either side breaks nothing).
 */
const BLOCKER_LABEL: Record<string, [string, string]> = {
  zakat_ownership_not_declared: ["The company's ownership is not declared — declare it in Company Settings.", "لم يُصرَّح بملكية الشركة — صرِّح بها في إعدادات الشركة."],
  zakat_not_eligible: ["The company is not 100 % Saudi/GCC-owned; the Zakat working paper covers only such a company (owner decision Q2).", "الشركة ليست مملوكة بالكامل لسعوديين/خليجيين؛ تغطي ورقة عمل الزكاة هذه الشركات فقط (قرار المالك Q2)."],
  zakat_regulations_not_in_force: ["This fiscal year starts before 1/1/2024 — the 1445H Regulations do not apply to it.", "تبدأ هذه السنة المالية قبل 1/1/2024 — لا تنطبق عليها لائحة 1445هـ."],
  zakat_balance_sheet_unbalanced: ["The balance sheet at the year-end does not balance; the base is read from it, so it must balance first.", "قائمة المركز المالي في نهاية السنة غير متوازنة؛ يُقرأ الوعاء منها فيجب أن تتوازن أولًا."],
  zakat_unclassified_accounts: ["Some accounts with a balance at the year-end have no Zakat classification — classify each; none is assumed.", "بعض الحسابات ذات الرصيد في نهاية السنة بلا تصنيف زكوي — صنِّف كلًّا منها؛ لا يُفترض شيء."],
  zakat_legacy_lines: ["Some ledger lines name no account and cannot be classified.", "بعض قيود الدفتر لا تسمّي حسابًا ولا يمكن تصنيفها."],
  zakat_no_books: ["Nothing is in the books at the year-end — no account carries a balance. A base read from an empty ledger would be a confident zero: record the year (or its opening balances) first.", "لا شيء في الدفاتر في نهاية السنة — لا رصيد على أي حساب. الوعاء المقروء من دفاتر فارغة صفرٌ مضلِّل: سجّل السنة (أو أرصدتها الافتتاحية) أولًا."],
  income_tax_no_books: ["The income statement for the year has no movement at all — record the year first; an empty year would compute a confident zero.", "قائمة الدخل للسنة بلا أي حركة — سجّل السنة أولًا؛ فالسنة الفارغة تُنتج صفرًا مضلِّلًا."],
  ownership_not_declared: ["The company's ownership is not declared — declare it in Company Settings.", "لم يُصرَّح بملكية الشركة — صرِّح بها في إعدادات الشركة."],
  income_tax_not_applicable: ["This company is 100 % Saudi/GCC-owned: it pays Zakat, not income tax.", "هذه الشركة مملوكة بالكامل لسعوديين/خليجيين: تدفع الزكاة لا ضريبة الدخل."],
  foreign_share_not_declared: ["A mixed-owned company declares its non-Saudi share in Company Settings.", "تصرّح الشركة المختلطة الملكية بحصة غير السعوديين في إعدادات الشركة."],
  income_tax_mixed_losses_open: ["For a mixed-owned company, losses carried forward are not computed — open question I-1.", "للشركة المختلطة الملكية لا تُحتسب الخسائر المرحلة — سؤال مفتوح I-1."],
  income_tax_pool_not_computed: ["The Art. 17 depreciation pool cannot be computed for this year — resolve it on the income-tax pool page.", "تعذّر احتساب وعاء الإهلاك وفق المادة 17 لهذه السنة — عالجه في صفحة وعاء ضريبة الدخل."],
  income_tax_pool_year_missing: ["The Art. 17 pool has no figures for this year (it starts at its declared anchor year).", "لا أرقام لوعاء المادة 17 لهذه السنة (يبدأ من سنة الأساس المُعلنة)."],
};
export const blockerLabel = (code: string, serverMessage: string, t: T) => (BLOCKER_LABEL[code] ? t(...BLOCKER_LABEL[code]) : serverMessage);

/** Art. 27's branches, as the engine names them. */
export const minimumRuleLabel = (rule: string, t: T) =>
  ({
    not_applied: t("The minimum base did not bind (Art. 27).", "لم يُطبَّق الحد الأدنى للوعاء (المادة 27)."),
    "27(2)": t("Art. 27(2): the base by the method was below the adjusted net profit, so the base is the LOWER of the adjusted net profit and the undeducted assets plus the difference.", "المادة 27(2): كان الوعاء وفق الطريقة أقل من صافي الربح المعدل، فالوعاء هو الأقل من صافي الربح المعدل والأصول غير المحسومة مضافًا إليها الفرق."),
    "27(3)": t("Art. 27(3): no adjusted profit and a negative base — there is no base.", "المادة 27(3): لا ربح معدل والوعاء سالب — فلا وعاء."),
    "27(4)": t("Art. 27(4): no adjusted profit and a positive base — the base by the method stands.", "المادة 27(4): لا ربح معدل والوعاء موجب — يبقى الوعاء وفق الطريقة."),
  } as Record<string, string>)[rule] ?? rule;

/** A step's article column: the engine writes article numbers, plus two words — translated here. */
export const articleLabel = (a: string, t: T) =>
  a === "declared" ? t("declared", "مُقرّ") : a.replace(" (not applied)", ` ${t("(not applied)", "(لم يُطبَّق)")}`);

export const adjustmentTargetLabel = (s: string, t: T) =>
  ({ adjusted_net_profit: t("Adjusted net profit", "صافي الربح المعدل"), zakat_base: t("Zakat base (direct)", "الوعاء الزكوي (مباشرة)"), taxable_income: t("Taxable income", "الدخل الخاضع للضريبة") } as Record<string, string>)[s] ?? s;

// ── Treasury ────────────────────────────────────────────────────────────────
export const flowKindLabel = (k: string, t: T) =>
  ({ actual: t("Actual", "فعلي"), committed: t("Committed", "ملتزم به"), expected: t("Expected", "متوقع"), forecast: t("Forecast", "تنبؤ"), manual: t("Manual assumption", "افتراض يدوي") } as Record<string, string>)[k] ?? k;
export const flowCategoryLabel = (c: string, t: T) =>
  ({ receivables: t("Customer receipts", "مقبوضات العملاء"), payables: t("Supplier bills", "فواتير الموردين"), payment_plans: t("Payment plans", "خطط الدفع"), tax: t("Tax", "الضرائب"), payroll: t("Payroll", "الرواتب"), recurring: t("Recurring", "المتكرر"), assumptions: t("Assumptions", "الافتراضات") } as Record<string, string>)[c] ?? c;
export const planStatusLabel = (s: string, t: T) =>
  ({ planned: t("Planned", "مخطط"), approved: t("Approved", "معتمد"), paid: t("Paid", "مدفوع"), cancelled: t("Cancelled", "ملغى") } as Record<string, string>)[s] ?? s;
export const priorityLabel = (p: string, t: T) => ({ high: t("High", "عالية"), normal: t("Normal", "عادية"), low: t("Low", "منخفضة") } as Record<string, string>)[p] ?? p;
export const assumptionCategoryLabel = (c: string, t: T) =>
  ({ financing: t("Financing", "تمويل"), capex: t("Capital expenditure", "إنفاق رأسمالي"), tax: t("Tax", "ضرائب"), payroll: t("Payroll", "رواتب"), receipt: t("Receipt", "مقبوضات"), payment: t("Payment", "مدفوعات"), other: t("Other", "أخرى") } as Record<string, string>)[c] ?? c;
export const obligationKindLabel = (k: string, t: T) =>
  ({ wht: t("Withholding tax", "ضريبة الاستقطاع"), zakat: t("Zakat", "الزكاة"), income_tax: t("Income tax", "ضريبة الدخل"), vat: t("VAT", "ضريبة القيمة المضافة") } as Record<string, string>)[k] ?? k;
