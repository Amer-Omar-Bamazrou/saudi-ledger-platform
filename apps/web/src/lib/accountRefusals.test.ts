/**
 * G55 / DR-42 — the refusal for an account this company cannot post to, in
 * both languages, from both error classes, keyed on CODE + FIELD only.
 */
import { describe, expect, it } from "vitest";
import { accountRefusalToast } from "./accountRefusals";

const en = (e: string) => e;
const ar = (_e: string, a: string) => a;
/** The generated client's error: the body under `.data`, the message truncated. */
const generated = (body: Record<string, unknown>) =>
  Object.assign(new Error(`HTTP 422 Unprocessable Entity: ${String(body.error).slice(0, 20)}…`), { data: body });
/** `apiFetch`'s error. */
const fetched = (body: Record<string, unknown>) => Object.assign(new Error(String(body.error)), { code: body.code, body });

const G55 = 'Line 2 posts to "B Main", the cash account of a bank account that belongs to another company. A bank account\'s cash account takes entries only from its own company — choose one of this company\'s own bank accounts.';
const G04 = "Line 2 names an account that does not exist for this organization.";

describe("G55 — an account this company cannot post to", () => {
  it("🔴 a journal line: the server's own sentence in English, the line number in Arabic — from both clients", () => {
    for (const make of [generated, fetched]) {
      const err = make({ code: "reference_not_found", field: "lines[1].accountId", error: G55 });
      expect(accountRefusalToast(err, en)).toEqual({ title: "This company cannot post to that account", description: G55, variant: "destructive" });
      const inArabic = accountRefusalToast(err, ar)!;
      expect(inArabic.title).toBe("لا يمكن لهذه الشركة الترحيل إلى هذا الحساب");
      expect(inArabic.description).toContain("السطر 2");
      expect(inArabic.description).toContain("لبنك تابع لشركة أخرى");
    }
  });

  it("the same not-found code from G04 (another organisation, or no such account) gets the same explanation — true of both", () => {
    const err = fetched({ code: "reference_not_found", field: "lines[0].accountId", error: G04 });
    expect(accountRefusalToast(err, en)?.description).toBe(G04);
    expect(accountRefusalToast(err, ar)?.description).toContain("السطر 1");
    expect(accountRefusalToast(err, ar)?.description).toContain("حساب غير موجود");
  });

  it("a recognition schedule: the balance-sheet account at create, and the posted entry's line at recognition", () => {
    const create = generated({ code: "balance_account_unknown", field: "balanceAccountId", error: "“B Main” is the cash account of a bank account that belongs to another company." });
    expect(accountRefusalToast(create, en, "schedule")?.description).toContain("another company");
    expect(accountRefusalToast(create, ar, "schedule")?.description).toContain("حساب الميزانية المختار");
    const recognise = fetched({ code: "reference_not_found", field: "lines[1].accountId", error: G55 });
    expect(accountRefusalToast(recognise, ar, "schedule")?.description).toContain("قيد هذا الجدول");
    expect(accountRefusalToast(recognise, ar, "schedule")?.description).toContain("لم يُرحَّل شيء");
  });

  it("anything else is not this refusal — the page keeps its own toast", () => {
    for (const body of [
      { code: "reference_not_found", field: "lines[0].customerId", error: "x" },
      { code: "reference_not_found", field: "capitalisesAssetId", error: "x" },
      { code: "account_not_posting", field: "lines[0].accountId", error: "x" },
      { code: "balance_account_type_mismatch", field: "balanceAccountId", error: "x" },
    ]) {
      expect(accountRefusalToast(fetched(body), en), JSON.stringify(body)).toBeNull();
    }
    expect(accountRefusalToast(new Error("network down"), en)).toBeNull();
  });
});
