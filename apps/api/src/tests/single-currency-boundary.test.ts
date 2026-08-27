/**
 * SINGLE CURRENCY — the write-boundary guard (2026-08-26), DB-free.
 *
 * ── What this pins, and why it is a refusal ────────────────────────────────
 * `currency` is stored on nine tables and read by no aggregate: glPosting,
 * reports/analytics/summary repositories and the VAT return contain ZERO
 * references, and the schema has no exchange-rate column. A USD row therefore
 * had its bare number summed into SAR totals and the filed return.
 *
 * The invariant already existed in ONE path (transactions.service refuses
 * non-SAR statement rows — audit finding #4) while `bankAccounts.service`
 * allowlisted `currency` for direct client writes with no validation at all.
 * These tests pin the boundary version: the guard itself, and the fact that the
 * bank-account path now refuses BEFORE reaching the repository.
 *
 * 🔴 The last test is the anti-vacuity one: "it threw" is worth little unless
 * nothing was written. It asserts the repository was never called — otherwise a
 * guard that threw *after* an insert would pass a throw-only assertion.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const insertMock = vi.fn(async () => [{ id: 1, currency: "SAR", balance: "0.00", openingBalance: "0.00" }]);
const updateMock = vi.fn(async () => [{ id: 1, currency: "SAR", balance: "0.00", openingBalance: "0.00" }]);
const findByIdMock = vi.fn(async () => [{ id: 1, currency: "SAR", balance: "0.00", openingBalance: "0.00" }]);

vi.mock("../repositories/bankAccounts.repository", () => ({
  bankAccountsRepository: {
    insert: (...a: unknown[]) => insertMock(...(a as [])),
    update: (...a: unknown[]) => updateMock(...(a as [])),
    findById: (...a: unknown[]) => findByIdMock(...(a as [])),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => {}),
  },
}));
vi.mock("../services/audit.service", () => ({
  auditService: { created: vi.fn(), updated: vi.fn(), deleted: vi.fn(), record: vi.fn() },
}));

import { assertSupportedCurrency, SUPPORTED_CURRENCY } from "../lib/writeGuards";
import { bankAccountsService } from "../services/bankAccounts.service";

beforeEach(() => {
  insertMock.mockClear();
  updateMock.mockClear();
});

describe("assertSupportedCurrency — the guard itself", () => {
  it("accepts SAR, and accepts it case- and whitespace-insensitively", () => {
    expect(() => assertSupportedCurrency("SAR")).not.toThrow();
    expect(() => assertSupportedCurrency("sar")).not.toThrow();
    expect(() => assertSupportedCurrency("  Sar  ")).not.toThrow();
  });

  it("treats null/undefined as 'not stated' — the CHECK constrains value, not presence", () => {
    expect(() => assertSupportedCurrency(null)).not.toThrow();
    expect(() => assertSupportedCurrency(undefined)).not.toThrow();
  });

  it("🔴 refuses every other currency, and NAMES the one supplied", () => {
    for (const code of ["USD", "EUR", "AED", "GBP", "usd"]) {
      expect(() => assertSupportedCurrency(code)).toThrow(/must be SAR/i);
    }
    // The message must carry the offending code — a refusal the user cannot
    // act on is the diagnosability failure C5 closed elsewhere.
    expect(() => assertSupportedCurrency("USD")).toThrow(/USD/);
  });

  it("explains WHY, not just that it refused", () => {
    expect(() => assertSupportedCurrency("USD")).toThrow(/exchange rates|VAT return/i);
  });

  it("SUPPORTED_CURRENCY is the single source the message and CHECK agree on", () => {
    expect(SUPPORTED_CURRENCY).toBe("SAR");
  });
});

describe("bankAccountsService — the path that had NO validation", () => {
  it("creates normally when the currency is SAR", async () => {
    await bankAccountsService.create({ name: "Main", bankName: "SNB", currency: "SAR" });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it("creates normally when no currency is supplied at all", async () => {
    await bankAccountsService.create({ name: "Main", bankName: "SNB" });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it("🔴 REFUSES a USD account — and writes NOTHING (anti-vacuity)", async () => {
    await expect(
      bankAccountsService.create({ name: "Offshore", bankName: "HSBC", currency: "USD" }),
    ).rejects.toThrow(/must be SAR/i);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("🔴 REFUSES a currency change on UPDATE — the path a free-text input reached", async () => {
    await expect(bankAccountsService.update(1, { currency: "EUR" })).rejects.toThrow(/must be SAR/i);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
