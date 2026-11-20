/**
 * 🔴 Owner, 2026-11-19 (item 7): a regulatory review of A1, A15, A20 and A23 against ZATCA, SOCPA and IFRS found none
 * of them mandatory in its exact form. So:
 *  - (a) wherever a screen describes A1, A23 or A20's stated-reason rule, it says it is an INTERNAL CONTROL of the
 *    platform, and nothing presents it as a ZATCA, SOCPA or IFRS requirement;
 *  - (d) wherever a full-IFRS standard is cited on these controls' paths, the matching IFRS for SMEs section as
 *    endorsed in the Kingdom stands beside it: IAS 8 → Section 10, IAS 19 → Section 28, IFRS 15 → Section 23.
 *
 * Runtime values where they are exported (the A1 refusal, the protected-account rule); the source text where a screen
 * holds the words. No database. Red on main f8a2e1bb (assertion failures), green with the labels.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { protectedAccountRule } from "@workspace/shared";
import { BANK_DETAIL_REFUSALS } from "../lib/dbRefusals";

const root = join(import.meta.dirname, "..", "..", "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const lines = (p: string) => src(p).split(/\r?\n/);
const EN = /internal control/i;
const AR = /رقابة داخلية/;
/** A sentence that would present one of these controls as an external requirement. */
const AS_REQUIREMENT = /(ZATCA|SOCPA|IFRS)\s+(requires|require|mandates|mandate|obliges)\b|required by (ZATCA|SOCPA|IFRS)/i;

describe("owner 2026-11-19 — A1, A20 and A23 read as internal controls; IFRS for SMEs stands beside full IFRS", () => {
  it("🔴 A1: the linked-approver refusal says it is an internal control, in English and Arabic", () => {
    expect(BANK_DETAIL_REFUSALS.linkedApprover.error).toMatch(EN);
    expect(BANK_DETAIL_REFUSALS.linkedApprover.errorAr).toMatch(AR);
  });

  it("🔴 A1: the security trail's label for that refusal says so too", () => {
    const line = lines("apps/web/src/components/SecurityEventsCard.tsx").find((l) => l.includes('"bank_detail_change.approval_refused"'));
    expect(line, "the label exists").toBeDefined();
    expect(line).toMatch(EN);
    expect(line).toMatch(AR);
  });

  it("🔴 A23: the Controls card says its controls are the platform's own — not ZATCA, SOCPA or IFRS requirements", () => {
    const s = src("apps/web/src/components/ControlSettingsSection.tsx");
    expect(s).toMatch(/internal controls of this platform, not ZATCA, SOCPA or IFRS requirements/);
    expect(s).toMatch(/ضوابط رقابة داخلية في المنصة، وليست من متطلبات/);
  });

  it("🔴 A20: the stated-reason rule's refusal and the journal form's hint say so", () => {
    const service = src("apps/api/src/services/journalEntries.service.ts");
    const at = service.indexOf('code: "journal_line_party_reason_required"');
    expect(at, "the refusal exists").toBeGreaterThan(0);
    const refusal = service.slice(at, service.indexOf("});", at));
    expect(refusal).toMatch(EN);
    expect(refusal).toMatch(AR);
    const hint = src("apps/web/src/lib/journalLine.ts");
    const h = hint.slice(hint.indexOf('missed === "customer-or-reason"'), hint.indexOf(": t(", hint.indexOf('missed === "customer-or-reason"')));
    expect(h).toMatch(EN);
    expect(h).toMatch(AR);
  });

  it("🔴 nothing on these screens or refusals presents a control as a ZATCA, SOCPA or IFRS requirement", () => {
    for (const p of [
      "apps/web/src/components/SecurityEventsCard.tsx",
      "apps/web/src/components/ControlSettingsSection.tsx",
      "apps/web/src/lib/journalLine.ts",
      "apps/api/src/lib/dbRefusals.ts",
      "apps/api/src/services/journalEntries.service.ts",
    ]) expect(src(p), p).not.toMatch(AS_REQUIREMENT);
  });

  it("🔴 IAS 8 on the correction path carries IFRS for SMEs Section 10 — on the screen, in the refusal and in the request error", () => {
    const rule = protectedAccountRule("RETAINED_EARNINGS");
    expect(rule?.writtenBy).toMatch(/IAS 8, or IFRS for SMEs Section 10/);
    expect(rule?.writtenByAr).toMatch(/القسم 10 من المعيار الدولي للمنشآت الصغيرة والمتوسطة/);
    const labels = lines("apps/web/src/pages/JournalEntries.tsx").filter((l) => l.includes("Kind of correction (IAS 8"));
    expect(labels.length, "the two correction-kind labels").toBe(2);
    for (const l of labels) {
      expect(l).toMatch(/IFRS for SMEs Section 10/);
      expect(l).toMatch(/القسم 10 من المعيار الدولي للمنشآت الصغيرة والمتوسطة/);
    }
    const service = lines("apps/api/src/services/journalEntries.service.ts").filter((l) => /\(IAS 8\b/.test(l) || /IAS 8 kinds/.test(l));
    expect(service.length).toBeGreaterThan(0);
    for (const l of service) expect(l, l.trim()).toMatch(/IFRS for SMEs Section 10/);
  });

  it("🔴 IAS 19 on the payroll accrual carries Section 28; IFRS 15 on the advance's contract liability carries Section 23", () => {
    expect(src("apps/api/src/services/payroll.approvable.ts")).toMatch(/IAS 19\.11, IFRS for SMEs Section 28/);
    expect(src("apps/api/src/services/invoices.approvable.ts")).toMatch(/IFRS 15\.47, IFRS for SMEs Section 23/);
  });
});
