/**
 * Phase 13B S1 — the refusal titles keyed on the CODE, and the regression CI
 * found on PR #187: S1's map had taken over `credit_note_exceeds_invoice_vat`,
 * 13B-3's code for EVERY bill, so an ORDINARY bill's over-credit lost its
 * generic "Refused" title (e2e/phase13b3-credit-note-refusals.spec.ts).
 *
 * Both error shapes are exercised, because the page sees both: the generated
 * client's (`custom-fetch`: the body under `.data`, the message truncated) and
 * `apiFetch`'s (`@/lib/api`: `.code` / `.body`).
 */
import { describe, expect, it } from "vitest";
import { noteRefusalToast, openingVatRefusalTitle } from "./openingVatRefusals";

const en = (e: string) => e;
const ar = (_e: string, a: string) => a;
/** The generated client's error: HTTP prefix + a message cut at 300 characters; the whole body in `.data`. */
const generated = (code: string, error: string) =>
  Object.assign(new Error(`HTTP 422 Unprocessable Entity: ${error.slice(0, 20)}…`), { data: { code, error } });
/** `apiFetch`'s error. */
const fetched = (code: string, error: string) => Object.assign(new Error(error), { code, body: { code, error } });

const OVER_CREDIT = "This credit note reduces VAT by 200.00, but only 150.00 of the 150.00 VAT charged on B-1 is left after its other credit notes.";

describe("S1 refusal titles", () => {
  it("🔴 an ORDINARY bill's over-credit (13B-3) keeps the generic title, in both languages and from both clients — with the server's whole sentence", () => {
    expect(openingVatRefusalTitle("credit_note_exceeds_invoice_vat", en)).toBeNull();
    for (const err of [generated("credit_note_exceeds_invoice_vat", OVER_CREDIT), fetched("credit_note_exceeds_invoice_vat", OVER_CREDIT)]) {
      expect(noteRefusalToast(err, en)).toEqual({ title: "Refused", description: OVER_CREDIT, variant: "destructive" });
      expect(noteRefusalToast(err, ar).title).toBe("مرفوض");
    }
  });

  it("🔴 the other 13B-3 refusals stay generic too — S1 titles only its own codes", () => {
    for (const code of ["credit_note_before_original", "input_vat_note_interaction_undecided", "input_vat_note_allocation_undecided", "credit_exceeds_bill"]) {
      expect(openingVatRefusalTitle(code, en), code).toBeNull();
      expect(noteRefusalToast(generated(code, "x"), en).title, code).toBe("Refused");
    }
  });

  it("🔴 S1's opening-payable refusals keep their own titles, unchanged (EN and AR), with the server's whole sentence", () => {
    const expected: Array<[string, string, string]> = [
      ["supplier_note_evidence_missing", "Attach the supplier's credit note first", "أرفق إشعار الدائن الصادر من المورّد أولًا"],
      ["input_vat_note_opening_undeclared", "Declare the opening bill's VAT history first", "أعلِن أولًا تاريخ ضريبة الفاتورة الافتتاحية"],
      ["input_vat_note_opening_reversed", "This opening bill was reversed — record the note against the live bill", "هذه الفاتورة الافتتاحية معكوسة — سجّل الإشعار على الفاتورة القائمة"],
      ["input_vat_note_transitional_supply", "Not supported — a transitional-rate supply", "غير مدعوم — توريد بنسبة انتقالية"],
      ["input_vat_note_multistate", "Not supported yet — the bill's VAT is split", "غير مدعوم بعد — ضريبة الفاتورة مجزّأة"],
      ["input_vat_note_overpaid_reversed", "Not supported yet — this note would settle a reversed payable", "غير مدعوم بعد — هذا الإشعار يسوّي ذمة معكوسة ضريبتها"],
      ["opening_vat_declaration_evidence_missing", "Attach the evidence this history needs", "أرفق الأدلة التي يتطلبها هذا التاريخ"],
      ["opening_vat_declaration_state_not_enabled", "This history is not supported yet", "هذا التاريخ غير مدعوم بعد"],
    ];
    const long = "x".repeat(400); // longer than the generated client's 300-character message
    for (const [code, titleEn, titleAr] of expected) {
      expect(openingVatRefusalTitle(code, en), code).toBe(titleEn);
      expect(openingVatRefusalTitle(code, ar), code).toBe(titleAr);
      expect(noteRefusalToast(generated(code, long), en), code).toEqual({ title: titleEn, description: long, variant: "destructive" });
    }
  });
});
