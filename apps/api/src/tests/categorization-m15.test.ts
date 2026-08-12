/**
 * M15 — statement ingestion repair: the engine-side fixes.
 *
 * Each block pins one finding from the adversarial statement run:
 *   1. THE FORCING FUNCTION — every code the engine can emit exists in the
 *      seeded template, so the two spaces cannot drift apart again.
 *   2. VAT is EXTRACTED from gross, never applied to it.
 *   3. The salary heuristic fires on debits only.
 *   4. The engine can say "I don't know", and low confidence does not assign.
 */
import { describe, expect, it } from "vitest";
import { categorizeTransaction, allEngineCodes, SEED_CATEGORIES } from "../services/categorization/categorizer";
import { AUTO_ASSIGN_CONFIDENCE, vatFromGross } from "../services/categorization/resolveCategory";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("M15 §1 — THE FORCING FUNCTION: engine codes ⊆ seeded template", () => {
  /**
   * 🔴 This is the test that makes the id-mismatch class impossible to
   * reintroduce. The engine emitted ids from a private 1–30 list while the real
   * table used serial ids; nothing forced them to agree; the FK rejected every
   * auto-categorized row and the DEFAULT UPLOAD PATH IMPORTED NOTHING.
   *
   * The template lives in SQL (migrations 0025/0029) and the engine in
   * TypeScript, so the duplication is inherent — which is exactly why it is
   * pinned. If someone adds a rule with a new code and forgets the template row,
   * THIS fails, not a tenant's upload.
   */
  const migrationCodes = (): Set<string> => {
    const dir = join(__dirname, "..", "..", "..", "..", "packages", "db", "migrations");
    const sql =
      readFileSync(join(dir, "0025_m13_coa_template_and_trigger.sql"), "utf8") +
      readFileSync(join(dir, "0029_m15_default_categories.sql"), "utf8");
    const codes = new Set<string>();
    for (const m of sql.matchAll(/\(\s*'([A-Z_]+)'\s*,\s*'/g)) codes.add(m[1]);
    return codes;
  };

  it("🔴 every code the engine can emit has a seeded template row", () => {
    const template = migrationCodes();
    const missing = allEngineCodes().filter((c) => !template.has(c));
    expect(
      missing,
      "these engine codes have no seeded category — a matched transaction would land uncategorized",
    ).toEqual([]);
  });

  it("every SEED_CATEGORIES entry carries a code that exists in the template", () => {
    const template = migrationCodes();
    const missing = SEED_CATEGORIES.filter((c) => !template.has(c.systemCode)).map((c) => c.systemCode);
    expect(missing).toEqual([]);
  });
});

describe("M15 §2 — VAT is EXTRACTED from gross, never applied to it", () => {
  it("🔴 a SAR 431.25 statement line at 15% contains SAR 56.25 of VAT — not 64.69", () => {
    // A bank amount is GROSS: it is what left the account. The old arithmetic
    // (amount × 15/100) overstated EVERY input-VAT figure by 15%, and
    // summary.getVat reads transactions.vat_amount straight into the VAT
    // position — a filing error against ZATCA, not a display bug.
    expect(vatFromGross(431.25, 15)).toBe(56.25);
    expect(vatFromGross(431.25, 15)).not.toBe((431.25 * 15) / 100);
  });

  it("net + VAT reconstructs the gross exactly", () => {
    for (const gross of [115, 862.5, 1234.56, 15000]) {
      const vat = vatFromGross(gross, 15);
      const net = Math.round((gross - vat) * 100) / 100;
      expect(Math.round((net + vat) * 100) / 100).toBe(gross);
      // And the VAT really is 15% OF THE NET, which is the definition.
      expect(Math.abs(vat - net * 0.15)).toBeLessThan(0.01);
    }
  });

  it("zero and negative rates yield zero", () => {
    expect(vatFromGross(1000, 0)).toBe(0);
    expect(vatFromGross(1000, -5)).toBe(0);
  });
});

describe("M15 §3 — the salary heuristic fires on DEBITS only", () => {
  it("🔴 an inbound customer payment is NOT payroll", () => {
    // The adversarial run booked a SAR 34,500 customer receipt as
    // Salaries & Wages — revenue recorded as payroll expense — because the
    // heuristic fired on CREDITS. Payroll leaves a business account.
    const m = categorizeTransaction("INCOMING TRANSFER - CUSTOMER PAYMENT INV-2026-0412", 34500, "credit");
    expect(m?.categoryName).not.toBe("Salaries & Wages");
  });

  it("an outbound round salary transfer IS payroll", () => {
    const m = categorizeTransaction("SALARY TRANSFER - AHMED AL QAHTANI", 8000, "debit");
    expect(m?.systemCode).toBe("SALARIES");
  });
});

describe('M15 §4 — the engine can say "I don\'t know"', () => {
  it("🔴 a bare description returns NULL, not a confident-looking fallback", () => {
    // Pre-M15 this returned "Other Expenses" at 0.30 — a guess wearing the same
    // shape as a 0.98 match, indistinguishable in every report.
    expect(categorizeTransaction("TRANSFER", 3000, "debit")).toBeNull();
    expect(categorizeTransaction("REF 99213 MISC", 750, "credit")).toBeNull();
  });

  it("a reversal is no longer booked as income", () => {
    // "RETURNED PAYMENT" matched nothing and fell back to Other Income. Now it
    // is unknown, which is true — classifying a reversal needs the original.
    const m = categorizeTransaction("RETURNED PAYMENT - INSUFFICIENT FUNDS REF 77219", 4300, "credit");
    expect(m).toBeNull();
  });

  it("high-confidence matches still match", () => {
    expect(categorizeTransaction("ZAKAT PAYMENT ZATCA 2025", 18000, "debit")?.systemCode).toBe("ZAKAT_PAYMENT");
    expect(categorizeTransaction("SADAD PAYMENT - STC 0112345678", 862.5, "debit")?.systemCode).toBe("TELECOM");
  });

  it("the auto-assign threshold sits above the old fallback confidences", () => {
    // The old fallbacks were 0.30/0.35. If the threshold ever drops below them,
    // a reintroduced fallback would start assigning again.
    expect(AUTO_ASSIGN_CONFIDENCE).toBeGreaterThan(0.35);
  });
});
