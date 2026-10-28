/**
 * 🔴 Phase 18 G2a (decision 11): each correction route in the reader's
 * language, keyed on the server's route code — never on its English note.
 */
import { describe, expect, it } from "vitest";
import type { VatCorrectionReturn } from "@workspace/api-client-react";
import { correctionRouteText } from "./vatCorrections";

const en = (e: string) => e;
const ar = (_e: string, a: string) => a;
const base = {
  zatcaReference: "R-1", periodFrom: "2026-08", periodTo: "2026-08", filedOn: "2026-09-25", dueOn: "2026-09-30", errors: 1,
  netTaxDifference: 1, repeatedErrors: false, penaltyWaiverAutomated: false,
  resolution1117: { returnDueOn: "2026-09-30", mayQualify: false, conditionsBy: "2026-12-31" },
  notifyBy: null, discoveryPeriod: null, discoveryReturnFiled: null, routeNote: "the server's English",
} as unknown as VatCorrectionReturn;

describe("the correction route, in both languages (decision 11)", () => {
  it("🔴 each route has its own sentence, carrying its date or period, in English and in Arabic", () => {
    const routes = [
      { ...base, route: "amend_and_notify", notifyBy: "2026-10-25" },
      { ...base, route: "discovery_period_return", discoveryPeriod: "2026-10", discoveryReturnFiled: false },
      { ...base, route: "user_choice", discoveryPeriod: "2026-09", discoveryReturnFiled: true },
    ] as VatCorrectionReturn[];
    const english = routes.map((r) => correctionRouteText(r, en));
    expect(english.map((s, i) => s.includes(["2026-10-25", "2026-10", "2026-09"][i]!))).toEqual([true, true, true]);
    expect(english[2]).toMatch(/ZATCA's direction/);
    expect(new Set(english).size).toBe(3);
    expect(routes.every((r) => /[؀-ۿ]/.test(correctionRouteText(r, ar)))).toBe(true);
    expect(english.some((s) => s.includes("the server's English"))).toBe(false);
  });

  it("a return with no route reads as nothing", () => {
    expect(correctionRouteText({ ...base, route: null } as VatCorrectionReturn, en)).toBe("");
  });
});
