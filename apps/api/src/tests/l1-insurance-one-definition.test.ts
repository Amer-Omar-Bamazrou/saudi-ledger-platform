/**
 * 🔴 L1, the one fix (owner, 2026-11-25) — INSURANCE HAS ONE VAT DEFINITION.
 *
 * VAT IR Art. 29(7) (Arabic text checked by the owner) exempts only life insurance and life reinsurance; other insurance
 * is standard-rated. The chart of accounts said so (INSURANCE: treatment 'S', VAT applicable — migrations 0031/0033/
 * 0048); the bank-line categorizer said "exempt from VAT", not VAT-applicable, 0 % — citing nothing. The categorizer
 * now follows the chart: its seed category and its rule both say VAT applies at the standard rate, and this test reads
 * the chart's own row so the two cannot drift apart again.
 * The statutory / voluntary split (Art. 50(1)(c)) and a separate life-insurance category are NOT built here.
 */
import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { DEFAULT_VAT_RATE } from "@workspace/shared";
import { SEED_CATEGORIES, categorizeTransaction } from "../services/categorization/categorizer";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;

describe("L1 — the categorizer's insurance definition", () => {
  it("🔴 an insurance premium on a bank line is VAT-applicable at the standard rate — not exempt, not 0 %", () => {
    for (const text of ["TAWUNIYA MOTOR INSURANCE POLICY", "BUPA ARABIA MEDICAL PREMIUM", "قسط تأمين المركبات"]) {
      const r = categorizeTransaction(text, 3200, "debit");
      expect([text, r?.systemCode, r?.vatApplicable, r?.suggestedVatRate]).toEqual([text, "INSURANCE", true, DEFAULT_VAT_RATE]);
    }
  });

  it("🔴 the categorizer's own INSURANCE category says VAT applies, and no longer says 'exempt'", () => {
    const seed = SEED_CATEGORIES.find((c) => c.systemCode === "INSURANCE")!;
    expect(seed.vatApplicable).toBe(true);
    expect(seed.description ?? "").not.toMatch(/exempt/i);
  });

  it("control: a category the chart treats as out of scope stays without VAT (the fix moved insurance only)", () => {
    expect(SEED_CATEGORIES.find((c) => c.systemCode === "GOVT_FEES")!.vatApplicable).toBe(false);
  });
});

describeDb("L1 — one definition: the categorizer agrees with the chart of accounts' own row", () => {
  it("🔴 INSURANCE in the chart template is standard-rated and VAT-applicable, and the categorizer says the same", async () => {
    const { rows } = await pool.query(`SELECT default_tax_treatment, vat_applicable FROM system_account_templates WHERE code = 'INSURANCE'`);
    expect(rows).toEqual([{ default_tax_treatment: "S", vat_applicable: true }]);
    const seed = SEED_CATEGORIES.find((c) => c.systemCode === "INSURANCE")!;
    const rule = categorizeTransaction("TAWUNIYA MOTOR INSURANCE POLICY", 3200, "debit")!;
    expect([seed.vatApplicable, rule.vatApplicable]).toEqual([rows[0].vat_applicable, rows[0].vat_applicable]);
    expect(rule.suggestedVatRate).toBe(rows[0].default_tax_treatment === "S" ? DEFAULT_VAT_RATE : 0);
  });
});
