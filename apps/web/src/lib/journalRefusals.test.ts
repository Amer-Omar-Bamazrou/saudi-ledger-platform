/**
 * 🔴 The manual journal's own refusals in both languages, from both error
 * classes, keyed on CODE only (owner 2026-10-23 decision 2; 2026-10-27 midday
 * item 2).
 */
import { describe, expect, it } from "vitest";
import { journalRecordsNothing, journalRefusalToast } from "./journalRefusals";

const en = (e: string) => e;
const ar = (_e: string, a: string) => a;
/** The generated client's error: the body under `.data`, the message truncated. */
const generated = (body: Record<string, unknown>) =>
  Object.assign(new Error(`HTTP 422 Unprocessable Entity: ${String(body.error).slice(0, 20)}…`), { data: body });
/** `apiFetch`'s error. */
const fetched = (body: Record<string, unknown>) => Object.assign(new Error(String(body.error)), { code: body.code, body });

const RESERVED = 'The entry number "BILL-7" uses the prefix BILL-, which the system uses for a document\'s own entry. Choose another number, or leave it blank and the server numbers the entry. Nothing was saved.';

describe("the manual journal's refusals", () => {
  it("🔴 blank or all-zero amounts: a clear refusal in English and in Arabic, from both clients", () => {
    for (const make of [generated, fetched]) {
      const err = make({ code: "journal_entry_zero_amounts", field: "lines", error: "Journal entry records nothing." });
      expect(journalRefusalToast(err, en)).toEqual({
        title: "This entry records nothing",
        description: "Every amount in this entry is blank or zero. Enter the debit and credit amounts, then save. Nothing was saved.",
        variant: "destructive",
      });
      const inArabic = journalRefusalToast(err, ar)!;
      expect(inArabic.title).toBe("هذا القيد لا يسجّل شيئاً");
      expect(inArabic.description).toContain("فارغة أو صفر");
    }
  });

  it("🔴 entry_number_reserved: the server's own sentence in English; in Arabic, a sentence true of all three reserved shapes", () => {
    for (const make of [generated, fetched]) {
      const err = make({ code: "entry_number_reserved", field: "entryNumber", error: RESERVED });
      expect(journalRefusalToast(err, en)).toEqual({ title: "That entry number is reserved", description: RESERVED, variant: "destructive" });
      const inArabic = journalRefusalToast(err, ar)!;
      expect(inArabic.title).toBe("رقم القيد هذا محجوز");
      for (const shape of ["JE-", "بادئة قيد مستند", "-REV"]) expect(inArabic.description).toContain(shape);
    }
  });

  it("any other error is not this mapper's: null", () => {
    expect(journalRefusalToast(fetched({ code: "journal_entry_unbalanced", error: "x" }), en)).toBeNull();
    expect(journalRefusalToast(new Error("network"), en)).toBeNull();
  });

  it("Save is held back exactly while every amount is blank or zero", () => {
    expect([journalRecordsNothing(0, 0), journalRecordsNothing(25, 25), journalRecordsNothing(0, 25)]).toEqual([true, false, false]);
  });
});
