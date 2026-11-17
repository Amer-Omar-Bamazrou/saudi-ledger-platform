/** Walk W5/W6/W9 — a journal line's party, an entry's status and the party hint, in the reader's words. */
import { describe, expect, it } from "vitest";
import { journalStatusLabel, linePartyText, partyHint } from "./journalLine";

const ar = (_en: string, a: string) => a;
const en = (e: string) => e;
const names = { customer: (id: number) => (id === 7 ? "شركة الجولة" : undefined), vendor: (id: number) => (id === 9 ? "مورد الجولة" : undefined) };

describe("linePartyText — the party a line names, or the reason it names none", () => {
  it("🔴 A20's stated reason is shown", () => {
    expect(linePartyText({ partyNoneReason: "دافع لم يُعرف بعد" }, names, ar)).toBe("لا عميل — دافع لم يُعرف بعد");
  });
  it("the customer or supplier by name, and by number when the name is not loaded", () => {
    expect(linePartyText({ customerId: 7 }, names, ar)).toBe("العميل: شركة الجولة");
    expect(linePartyText({ vendorId: 9 }, names, en)).toBe("Supplier: مورد الجولة");
    expect(linePartyText({ customerId: 8 }, names, en)).toBe("Customer: #8");
  });
  it("absence: a line naming no one, with no reason, says nothing", () => {
    expect(linePartyText({}, names, ar)).toBeNull();
    expect(linePartyText({ partyNoneReason: "   " }, names, ar)).toBeNull();
  });
});

describe("journalStatusLabel — the status in words", () => {
  it("🔴 Arabic for the three states; an unknown state keeps its value", () => {
    expect(["draft", "posted", "reversed"].map((s) => journalStatusLabel(s, ar))).toEqual(["مسودة", "مرحّل", "معكوس"]);
    expect(journalStatusLabel("posted", en)).toBe("Posted");
    expect(journalStatusLabel("weird", ar)).toBe("weird");
  });
});

describe("partyHint — names the rule the line misses", () => {
  it("🔴 the customer-or-reason rule is not described as the receivable/payable rule", () => {
    expect(partyHint("customer-or-reason", ar)).toMatch(/يذكر سبب/);
    expect(partyHint("customer-or-reason", ar)).not.toMatch(/الذمم الدائنة/);
    expect(partyHint("named", ar)).toMatch(/الذمم الدائنة يحدد المورد/);
  });
});
