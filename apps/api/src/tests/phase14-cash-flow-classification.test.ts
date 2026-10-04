import { describe, it, expect } from "vitest";
import { SYSTEM_ACCOUNTS, SYSTEM_CHART_OF_ACCOUNTS } from "@workspace/db";
import { classifyCashFlowAccount, CASH_FLOW_LINE_ACTIVITY, CASH_FLOW_LINE_LABEL, type CashFlowLine } from "../services/reporting/cashFlowClassification";
import { toHalalas, fromHalalas, sumMoney } from "../lib/money";

/**
 * Phase 14 D14-07 — the cash-flow line of every SYSTEM account is a DECISION,
 * written down here, never a fall-through. 🔴 Both directions (§3: "when a map
 * replaces a map, assert both"): every system code has a row in this table,
 * and every row names a system code that exists. A new system account fails
 * this file until someone decides which cash-flow line it belongs to.
 *
 * `CASH` is the cash itself (IAS 7.9) — the cash flow never classifies it; it
 * is listed so the table is complete, not so it can be classified.
 */
const DECIDED: Record<string, CashFlowLine | "cash"> = {
  CASH: "cash",
  // operating — customers (IAS 7.14(a)); the four customer-money liabilities' exits are receipts/refunds to customers
  AR: "receipts_customers",
  CUSTOMER_DEPOSITS: "receipts_customers",
  CUSTOMER_CREDITS: "receipts_customers",
  UNIDENTIFIED_RECEIPTS: "receipts_customers",
  SALES: "receipts_customers",
  // operating — suppliers (IAS 7.14(c))
  AP: "payments_suppliers",
  SUPPLIER_ADVANCES: "payments_suppliers",
  PREPAID_EXPENSES: "payments_suppliers",
  ACCRUED_LIABILITIES: "payments_suppliers",
  UNIDENTIFIED_PAYMENTS: "payments_suppliers",
  PURCHASES: "payments_suppliers",
  BAD_DEBT_EXPENSE: "payments_suppliers",
  DEPRECIATION_EXPENSE: "payments_suppliers",
  // operating — employees (IAS 7.14(d))
  SALARIES: "payments_employees",
  SALARIES_PAYABLE: "payments_employees",
  GOSI_EXPENSE: "payments_employees",
  GOSI_PAYABLE: "payments_employees",
  // operating — taxes (IAS 7.35; VAT shown as its own line, IFRIC 2005 basis disclosed)
  VAT_OUTPUT: "taxes",
  VAT_INPUT: "taxes",
  VAT_AWAITING_EVIDENCE: "taxes",
  VAT_ADJ_NONPAYMENT: "taxes",
  VAT_ADJ_BLOCKED: "taxes",
  WHT_PAYABLE: "taxes",
  // operating — the entity's OWN taxes on income and Zakat, SEPARATELY DISCLOSED (IAS 7.35 as endorsed by
  // SOCPA, SOCPA-ED 24/12/2025 — Phase 16): never folded into the VAT/WHT line
  ZAKAT_PAYMENT: "zakat_income_tax",
  ZAKAT_EXPENSE: "zakat_income_tax",
  INCOME_TAX_PAYABLE: "zakat_income_tax",
  INCOME_TAX_EXPENSE: "zakat_income_tax",
  // a tax FINE is a cost, not a tax (SYSTEM_ACCOUNTS; absent from TAX_ACCOUNT_SYSTEM_CODES): an operating expense paid
  TAX_PENALTIES: "payments_suppliers",
  // operating — refundable security deposits: not a sale or a purchase; operating, listed apart
  SECURITY_DEPOSITS_PAID: "other_operating",
  SECURITY_DEPOSITS_HELD: "other_operating",
  // an accepted bank line not yet categorised: operating, NAMED as unidentified (never hidden in a total)
  SUSPENSE: "unidentified",
  // investing — the disposal travels whole (IAS 7.16(b))
  ACCUMULATED_DEPRECIATION: "non_current_assets",
  ASSET_DISPOSAL_GAIN_LOSS: "non_current_assets",
  // financing — owners (IAS 7.17(c)); money leaving to the owner is an equity movement (A, 2026-08-17)
  EXTERNAL_TRANSFERS: "owners",
  RETAINED_EARNINGS: "owners",
  // internal — own-account transfers are NOT flows (IAS 7.9)
  TRANSFER_CLEARING: "transfers_in_transit",
  TRANSFER_SUSPENSE: "transfers_awaiting_declaration",
};

describe("Phase 14 — the cash-flow classification of every system account is decided", () => {
  it("🔴 both directions: every system code has a decided line, and every decided code exists", () => {
    const codes = Object.values(SYSTEM_ACCOUNTS).sort();
    expect(Object.keys(DECIDED).sort()).toEqual(codes);
    expect(SYSTEM_CHART_OF_ACCOUNTS.map((d) => d.code).sort()).toEqual(codes);
  });

  it("🔴 each system account classifies to its decided line, from the SAME type and liquidity class the seed gives it", () => {
    for (const def of SYSTEM_CHART_OF_ACCOUNTS) {
      if (DECIDED[def.code] === "cash") { expect(def.liquidityClass, def.code).toBe("cash"); continue; }
      const got = classifyCashFlowAccount({ type: def.type, liquidityClass: def.liquidityClass ?? null, systemCode: def.code });
      expect(got, def.code).toBe(DECIDED[def.code]);
    }
  });

  it("🔴 Phase 16 — Zakat and income tax are their OWN operating line (IAS 7.35 as endorsed: separately disclosed); a fine is not a tax", () => {
    expect(CASH_FLOW_LINE_ACTIVITY.zakat_income_tax).toBe("operating");
    expect(CASH_FLOW_LINE_LABEL.zakat_income_tax.en).toMatch(/Zakat/);
    expect(CASH_FLOW_LINE_LABEL.taxes.en, "the VAT/WHT line must not claim Zakat or income tax").not.toMatch(/Zakat|income tax/i);
    for (const code of ["ZAKAT_PAYMENT", "ZAKAT_EXPENSE", "INCOME_TAX_PAYABLE", "INCOME_TAX_EXPENSE"]) {
      const def = SYSTEM_CHART_OF_ACCOUNTS.find((d) => d.code === code)!;
      const line = classifyCashFlowAccount({ type: def.type, liquidityClass: def.liquidityClass ?? null, systemCode: code });
      expect([code, line]).toEqual([code, "zakat_income_tax"]);
    }
    // the same account WITHOUT its system code would classify as an ordinary liability/expense — the code is what decides
    expect(classifyCashFlowAccount({ type: "liability", liquidityClass: "current", systemCode: null })).toBe("other_operating");
    expect(classifyCashFlowAccount({ type: "expense", liquidityClass: null, systemCode: "TAX_PENALTIES" })).toBe("payments_suppliers");
    expect(classifyCashFlowAccount({ type: "liability", liquidityClass: "current", systemCode: "WHT_PAYABLE" })).toBe("taxes");
  });

  it("🔴 own-account transfers are internal (never an activity); the undeclared transfer is held apart, never guessed operating", () => {
    expect(CASH_FLOW_LINE_ACTIVITY.transfers_in_transit).toBe("internal");
    expect(CASH_FLOW_LINE_ACTIVITY.transfers_awaiting_declaration).toBe("internal");
    expect(CASH_FLOW_LINE_ACTIVITY.non_current_assets).toBe("investing");
    expect([CASH_FLOW_LINE_ACTIVITY.owners, CASH_FLOW_LINE_ACTIVITY.borrowings]).toEqual(["financing", "financing"]);
  });

  it("user accounts (no system code) classify by type and liquidity class; an unknown type is listed under 'other', never guessed", () => {
    const c = (type: string | null, liquidityClass: string | null = null) => classifyCashFlowAccount({ type, liquidityClass, systemCode: null });
    expect([c("income"), c("revenue"), c("expense"), c("equity")]).toEqual(["receipts_customers", "receipts_customers", "payments_suppliers", "owners"]);
    expect([c("asset", "non_current"), c("asset", "current"), c("asset", null)]).toEqual(["non_current_assets", "other_operating", "other_operating"]);
    expect([c("liability", "non_current"), c("liability", "current")]).toEqual(["borrowings", "other_operating"]);
    expect([c(null), c("mystery")]).toEqual(["other_operating", "other_operating"]);
    // a fixed asset's cost or accumulated-depreciation account is investing even with NO liquidity class (review L1)
    expect(classifyCashFlowAccount({ type: "asset", liquidityClass: null, systemCode: null, fixedAsset: true })).toBe("non_current_assets");
  });

  it("every line has an English AND an Arabic label", () => {
    for (const line of Object.keys(CASH_FLOW_LINE_ACTIVITY) as CashFlowLine[]) {
      expect(CASH_FLOW_LINE_LABEL[line].en, line).toBeTruthy();
      expect(CASH_FLOW_LINE_LABEL[line].ar, line).toMatch(/[؀-ۿ]/);
    }
  });
});

describe("Phase 14 — exact money for report totals (lib/money.ts toHalalas / sumMoney)", () => {
  it("🔴 parses the numeric aggregate strings Postgres returns, exactly, including trailing zeros past two places", () => {
    expect([toHalalas("0"), toHalalas("12.3"), toHalalas("12.30"), toHalalas("12.3400"), toHalalas("-0.50"), toHalalas("1000000.01")]).toEqual([0, 1230, 1230, 1234, -50, 100000001]);
    expect([toHalalas(null), toHalalas(undefined), toHalalas("")]).toEqual([0, 0, 0]);
  });

  it("🔴 refuses what is not a 2-decimal amount instead of rounding it silently", () => {
    for (const bad of ["12.345", "abc", "1e3", "12.3450", " - 5"]) expect(() => toHalalas(bad), bad).toThrow(RangeError);
    expect(() => toHalalas(Number.NaN)).toThrow(RangeError);
    expect(() => fromHalalas(1.5)).toThrow(RangeError);
  });

  it("🔴 Σ is exact where float addition is not — the property, and the figure that moves", () => {
    const tenths = Array.from({ length: 10 }, () => "0.10");
    expect(tenths.reduce((s, v) => s + Number(v), 0)).not.toBe(1); // the float sum drifts…
    expect(sumMoney(tenths)).toBe(1);                              // …the halala sum does not
    expect(sumMoney(["0.10", "0.20"])).toBe(0.3);
    expect(sumMoney(["100.01", "-100.01", "0.01"])).toBe(0.01);
  });
});
