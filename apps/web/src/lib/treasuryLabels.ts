/**
 * Phase 17 — the Treasury page's own bilingual vocabulary and drill targets,
 * keyed by the API's codes (never by English text — CLAUDE.md §3 "key the UI
 * on the structured CODE"). The shared tax/treasury labels (flow kind,
 * category, plan status, priority, assumption category) live in
 * `lib/taxLabels.ts`; this file adds only what the Treasury page alone needs.
 */
type T = (en: string, ar: string) => string;

/** The five tabs, in order. The active one is the URL's `?tab=`. */
export const TREASURY_TABS = ["overview", "forecast", "plans", "assumptions", "settings"] as const;
export type TreasuryTab = (typeof TREASURY_TABS)[number];
export const parseTreasuryTab = (raw: string | null): TreasuryTab =>
  (TREASURY_TABS as readonly string[]).includes(raw ?? "") ? (raw as TreasuryTab) : "overview";

export const treasuryTabLabel = (tab: TreasuryTab, t: T) =>
  ({
    overview: t("Overview", "نظرة عامة"),
    forecast: t("Forecast", "التوقع النقدي"),
    plans: t("Payment plans", "خطط الدفع"),
    assumptions: t("Assumptions", "الافتراضات"),
    settings: t("Settings", "الإعدادات"),
  })[tab];

/** Why a row sits in bucket 0 — its date passed, or it has none. Never re-dated to today. */
export const bucketReasonLabel = (r: string | null | undefined, t: T) =>
  r === "overdue" ? t("Overdue", "متأخر") : r === "undated" ? t("Undated", "بلا تاريخ") : "";

export const directionLabel = (d: string, t: T) => (d === "in" ? t("In", "وارد") : t("Out", "صادر"));
export const assumptionDirectionLabel = (d: string, t: T) => (d === "inflow" ? t("Inflow", "تدفق وارد") : t("Outflow", "تدفق صادر"));

/** What a forecast row was read from. */
export const sourceTypeLabel = (type: string, t: T) =>
  ({
    invoice: t("Invoice", "فاتورة"),
    bill: t("Supplier bill", "فاتورة مورد"),
    scheduled_payment: t("Payment plan", "خطة دفع"),
    tax_wht: t("Withholding tax", "ضريبة الاستقطاع"),
    tax_zakat: t("Zakat", "الزكاة"),
    tax_income_tax: t("Income tax", "ضريبة الدخل"),
    tax_vat: t("VAT", "ضريبة القيمة المضافة"),
    recurring_rule: t("Recurring rule", "قاعدة متكررة"),
    treasury_forecast_entry: t("Manual assumption", "افتراض يدوي"),
    gl_account: t("Payroll payable", "رواتب مستحقة"),
  } as Record<string, string>)[type] ?? type;

/**
 * Where a forecast row's source can be opened — the page that owns that
 * figure. `null` when no page exists for it (the row still names its source).
 */
export function sourceHref(type: string): string | null {
  switch (type) {
    case "invoice": return "/invoices";
    case "bill": return "/bills";
    case "scheduled_payment": return "/treasury?tab=plans";
    case "tax_wht": return "/tax/withholding";
    case "tax_zakat": return "/zakat";
    case "tax_income_tax": return "/tax/income-tax";
    case "tax_vat": return "/vat";
    case "recurring_rule": return "/recurring";
    case "treasury_forecast_entry": return "/treasury?tab=assumptions";
    case "gl_account": return "/payroll";
    default: return null;
  }
}
