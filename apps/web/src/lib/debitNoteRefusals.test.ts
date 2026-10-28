/**
 * 🔴 Phase 18 G1 — owner decision 8: a debit note's refusals in both languages,
 * from both error classes, keyed on CODE only; and the route each non-price
 * charge takes instead.
 */
import { describe, expect, it } from "vitest";
import { CHARGE_SUBSTANCES, art54Deadline } from "@workspace/shared";
import { chargeSubstanceLabel, chargeSubstanceRoute, debitNoteRefusalText } from "./debitNoteRefusals";

const en = (e: string) => e;
const ar = (_e: string, a: string) => a;
const generated = (body: Record<string, unknown>) =>
  Object.assign(new Error(`HTTP 422 Unprocessable Entity: ${String(body.error).slice(0, 20)}…`), { data: body });
const fetched = (body: Record<string, unknown>) => Object.assign(new Error(String(body.error)), { code: body.code, body });

const CODES = [
  "debit_note_substance_required", "extra_charge_is_new_supply", "extra_charge_is_compensation", "late_payment_fee_needs_substance",
  "charge_event_date_required", "charge_event_date_before_original", "charge_event_date_after_note",
];

describe("a debit note's substance (decision 8)", () => {
  it("🔴 every refusal has its own sentence in English and in Arabic, from both clients, whatever the server's wording", () => {
    for (const make of [generated, fetched]) {
      const english = CODES.map((code) => debitNoteRefusalText(make({ code, error: "reworded by the server" }), en));
      const arabic = CODES.map((code) => debitNoteRefusalText(make({ code, error: "reworded by the server" }), ar));
      expect(english.every((s) => typeof s === "string" && s.length > 20 && !s.includes("reworded"))).toBe(true);
      expect(arabic.every((s) => typeof s === "string" && /[؀-ۿ]/.test(s!))).toBe(true);
      expect(new Set(english).size, "each refusal says something different").toBe(CODES.length);
    }
  });

  it("an error that is not a decision-8 refusal is left to the caller", () => {
    expect(debitNoteRefusalText(fetched({ code: "note_over_credit", error: "x" }), en)).toBeNull();
    expect(debitNoteRefusalText(new Error("network"), en)).toBeNull();
  });

  it("🔴 only a price change is a debit note: every other substance names its route, in both languages", () => {
    expect(CHARGE_SUBSTANCES.map((s) => [s, chargeSubstanceRoute(s, en) === null])).toEqual([
      ["price_change", true], ["new_supply", false], ["compensation", false], ["late_payment_fee", false],
    ]);
    for (const s of CHARGE_SUBSTANCES) expect(chargeSubstanceLabel(s, ar)).toMatch(/[؀-ۿ]/);
  });

  it("the Art. 54(6) deadline is the 15th of the month after the price changed, across a year end", () => {
    expect([art54Deadline("2026-09-01"), art54Deadline("2026-09-30"), art54Deadline("2026-12-31")]).toEqual(["2026-10-15", "2026-10-15", "2027-01-15"]);
  });
});
