/**
 * PHASE 14 — D14-07: which cash-flow activity an account's movement against
 * cash belongs to. Deterministic: account TYPE, LIQUIDITY CLASS and SYSTEM CODE
 * only — never the account's name (a tenant-owned label, and in Arabic for an
 * Arabic tenant; M18.1 retired name-sniffing here once already), never a guess.
 *
 * AUTHORITY
 * - IAS 7.6 / 7.13–17 — operating, investing, financing.
 * - IAS 7.9 — movements between items that constitute cash are not cash flows.
 * - IAS 7.16 — investing is expenditure resulting in a recognised asset (and
 *   the proceeds of disposing of one).
 * - IAS 7.35–36 as amended by SOCPA (SOCPA-ED, 24/12/2025) — taxes on income
 *   AND ZAKAT are operating unless specifically identified otherwise.
 * - IFRIC agenda decision, August 2005 — IAS 7 is silent on VAT; disclose
 *   whether gross flows are inclusive of it. We present them INCLUSIVE.
 * PRECEDENT
 * - Odoo `account_data.xml` "TAGS FOR CASH FLOW STATEMENT DIRECT METHOD":
 *   operating / investing / financing tags on COUNTERPART accounts. This is
 *   the same direct-by-counterpart model, with the classification derived
 *   from the chart rather than tags a tenant must maintain.
 *
 * Known limitations (decision pack D14-07, OPEN):
 * - L-CF1: a supplier payment settling a bill that CAPITALISED a non-current
 *   asset hits AP and so reads as operating; IAS 7.16 would make it investing.
 * - L-CF2: a tenant-created short-term loan on a CURRENT liability account
 *   reads as operating; a per-account override is the remedy (owner decision).
 */

export type CashFlowActivity = "operating" | "investing" | "financing" | "internal";
export type CashFlowLine =
  | "receipts_customers"
  | "payments_suppliers"
  | "payments_employees"
  | "taxes"
  | "zakat_income_tax"
  | "unidentified"
  | "other_operating"
  | "non_current_assets"
  | "owners"
  | "borrowings"
  | "transfers_in_transit"
  | "transfers_awaiting_declaration";

export const CASH_FLOW_LINE_ACTIVITY: Record<CashFlowLine, CashFlowActivity> = {
  receipts_customers: "operating",
  payments_suppliers: "operating",
  payments_employees: "operating",
  taxes: "operating",
  zakat_income_tax: "operating",
  unidentified: "operating",
  other_operating: "operating",
  non_current_assets: "investing",
  owners: "financing",
  borrowings: "financing",
  transfers_in_transit: "internal",
  transfers_awaiting_declaration: "internal",
};

/** Bilingual labels, keyed — the UI and the exports translate by key, never by English text. */
export const CASH_FLOW_LINE_LABEL: Record<CashFlowLine, { en: string; ar: string }> = {
  receipts_customers: { en: "Cash received from customers and other income", ar: "النقد المحصّل من العملاء والإيرادات الأخرى" },
  payments_suppliers: { en: "Cash paid to suppliers and for expenses", ar: "النقد المدفوع للموردين وللمصروفات" },
  payments_employees: { en: "Cash paid to and for employees", ar: "النقد المدفوع للموظفين ونيابةً عنهم" },
  taxes: { en: "VAT and withholding tax paid, net of refunds", ar: "ضريبة القيمة المضافة وضريبة الاستقطاع المدفوعة بالصافي" },
  zakat_income_tax: { en: "Zakat and income tax paid", ar: "الزكاة وضريبة الدخل المدفوعة" },
  unidentified: { en: "Movements awaiting classification (suspense)", ar: "حركات بانتظار التصنيف (معلّقة)" },
  other_operating: { en: "Other operating movements", ar: "حركات تشغيلية أخرى" },
  non_current_assets: { en: "Purchase and disposal of non-current assets", ar: "شراء الأصول غير المتداولة واستبعادها" },
  owners: { en: "Owner contributions and withdrawals", ar: "مساهمات المالك ومسحوباته" },
  borrowings: { en: "Long-term borrowings", ar: "القروض طويلة الأجل" },
  transfers_in_transit: { en: "Transfers between own accounts still in transit", ar: "تحويلات بين حسابات المنشأة لا تزال قيد التحويل" },
  transfers_awaiting_declaration: { en: "Transfers awaiting declaration (destination not yet stated)", ar: "تحويلات بانتظار التصريح (لم تُحدَّد وجهتها بعد)" },
};

const CUSTOMER_CODES = new Set(["AR", "CUSTOMER_DEPOSITS", "CUSTOMER_CREDITS", "UNIDENTIFIED_RECEIPTS"]);
const SUPPLIER_CODES = new Set(["AP", "SUPPLIER_ADVANCES", "PREPAID_EXPENSES", "ACCRUED_LIABILITIES", "UNIDENTIFIED_PAYMENTS"]);
const EMPLOYEE_CODES = new Set(["SALARIES_PAYABLE", "GOSI_PAYABLE", "SALARIES", "GOSI_EXPENSE"]);
/**
 * VAT and WHT settled with ZATCA. WHT is tax WITHHELD from a supplier and
 * remitted on its behalf — not the entity's own tax on income — so it sits with
 * VAT. 🔴 VAT_PAYMENT (the default category a VAT remittance bank line is
 * categorised to) was missing, so a remittance read as "other operating" while
 * the cash-flow page says VAT settled with ZATCA is its own line — found while
 * adding the Zakat codes (pack §13), fixed here.
 */
const TAX_CODES = new Set([
  "VAT_OUTPUT", "VAT_INPUT", "VAT_AWAITING_EVIDENCE", "VAT_ADJ_NONPAYMENT", "VAT_ADJ_BLOCKED", "VAT_PAYMENT", "WHT_PAYABLE",
]);
/**
 * Phase 16 — the entity's OWN taxes on income, and Zakat. IAS 7.35 as endorsed
 * by SOCPA (SOCPA-ED 24/12/2025; the header): "cash flows arising from taxes on
 * income [and Zakat] shall be SEPARATELY DISCLOSED and classified as operating"
 * — so they have their own line, never folded into VAT. The expense accounts
 * are listed for a direct payment posted without an accrual.
 *
 * TAX_PENALTIES is deliberately NOT here or in TAX_CODES: a fine is a cost, not
 * a tax (SYSTEM_ACCOUNTS; it is likewise absent from TAX_ACCOUNT_SYSTEM_CODES —
 * one definition), so it classifies by its type as an operating expense paid.
 */
const ZAKAT_INCOME_TAX_CODES = new Set(["ZAKAT_PAYMENT", "ZAKAT_EXPENSE", "INCOME_TAX_PAYABLE", "INCOME_TAX_EXPENSE"]);
/** An accepted bank line still lacking a category: an operating movement not yet classified. */
const UNIDENTIFIED_CODES = new Set(["SUSPENSE"]);
/** Disposal gain/loss travels with the disposal it arises from (IAS 7.16(b)): the
 * proceeds land WHOLLY in investing — cost credit − accumulated-depreciation
 * debit + gain credit = the cash received. */
const INVESTING_CODES = new Set(["ASSET_DISPOSAL_GAIN_LOSS", "ACCUMULATED_DEPRECIATION"]);

export interface ClassifiableAccount {
  type: string | null | undefined;
  liquidityClass: string | null | undefined;
  systemCode: string | null | undefined;
  /**
   * The account is the cost or accumulated-depreciation account of an asset
   * category: buying or disposing of a fixed asset is INVESTING (IAS 7.16) even
   * when the tenant left its liquidity class unset (accounting review L1).
   */
  fixedAsset?: boolean;
}

/**
 * The line (and so the activity) a non-cash account's movement against cash
 * belongs to. A cash account is never passed here — the caller excludes it
 * (IAS 7.9). Order matters: system codes first (they carry meaning a type
 * alone cannot), then type + liquidity class, then the honest fallback.
 */
export function classifyCashFlowAccount(a: ClassifiableAccount): CashFlowLine {
  const code = a.systemCode ?? null;
  if (code === "TRANSFER_CLEARING") return "transfers_in_transit";
  // 🔴 An UNDECLARED transfer (A, owner 2026-08-17) is not operating: until its
  // destination is stated it may be cash-to-cash (IAS 7.9 — no flow) or money
  // leaving to the owner (financing). It is held apart, never classified by
  // guess — the Audit Tier 3 finding-8 rule, carried into the ledger model.
  if (code === "TRANSFER_SUSPENSE") return "transfers_awaiting_declaration";
  if (code && INVESTING_CODES.has(code)) return "non_current_assets";
  if (a.fixedAsset) return "non_current_assets";
  if (code && CUSTOMER_CODES.has(code)) return "receipts_customers";
  if (code && SUPPLIER_CODES.has(code)) return "payments_suppliers";
  if (code && EMPLOYEE_CODES.has(code)) return "payments_employees";
  if (code && TAX_CODES.has(code)) return "taxes";
  if (code && ZAKAT_INCOME_TAX_CODES.has(code)) return "zakat_income_tax";
  if (code && UNIDENTIFIED_CODES.has(code)) return "unidentified";
  switch (a.type) {
    case "income":
    case "revenue":
      return "receipts_customers";
    case "expense":
      return "payments_suppliers";
    case "equity":
      return "owners";
    case "asset":
      return a.liquidityClass === "non_current" ? "non_current_assets" : "other_operating";
    case "liability":
      return a.liquidityClass === "non_current" ? "borrowings" : "other_operating";
    default:
      // no type (a legacy line with no account id) or an unknown type: listed, never guessed
      return "other_operating";
  }
}
