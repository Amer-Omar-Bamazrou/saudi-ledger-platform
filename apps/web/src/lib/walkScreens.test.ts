/**
 * 🔴 The Phase 18 walk (2026-11-17, Arabic, 390 px) — the screens' defect shapes, held at the source.
 *
 * The walk found each of these on a screen Phase 18 added or the audit round or the owner's four decisions touched. The
 * web suite is deliberately node-only (vitest.config.ts), so — as A25's refusal test does — this file reads each
 * screen's source and refuses the shape the walk saw; the behaviour of the helpers they now use is tested beside them
 * (`businessTime.test.ts`, `journalLine.test.ts`), and the browser spec `phase18-walk-screens.spec.ts` renders the result.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/** The in-frame screens with their own error toast (A25's global fallback never sees them). */
const OWN_TOASTS = [
  "components/BankDetailChangesSection.tsx",
  "components/ControlSettingsSection.tsx",
  "components/PeriodRecords.tsx",
  "components/VatCorrections.tsx",
  "components/tax/WhtClaims.tsx",
  "components/tax/WhtContracts.tsx",
  "components/payments/PaymentDetail.tsx",
  "pages/JournalEntries.tsx",
  "pages/Approvals.tsx",
  "pages/UserManagement.tsx",
];

describe("Phase 18 walk — the walked screens' defect shapes are gone", () => {
  it("🔴 W1: the security and audit trails never print an instant's UTC clock as its time", () => {
    for (const f of ["components/SecurityEventsCard.tsx", "pages/AuditTrail.tsx"]) {
      expect(src(f), f).not.toMatch(/createdAt\.slice\(\s*(0|11)/);
      expect(src(f), f).toContain("businessInstant(");
    }
  });

  it("🔴 W1/W12: counts and month names on the walked screens are in the app's digits (Latin, N-11)", () => {
    for (const f of ["components/SecurityEventsCard.tsx", "pages/AuditTrail.tsx", "pages/JournalEntries.tsx", "components/FilterScope.tsx"]) {
      expect(src(f), f).not.toContain(".toLocaleString()");
    }
    expect(src("pages/ClosedMonths.tsx")).not.toMatch(/Intl\.DateTimeFormat\(lang === "ar" \? "ar-SA" :/);
  });

  it("🔴 W2: an in-frame error toast describes a refusal through refusalOf, never the raw message", () => {
    const raw = /description:\s*(e|err|error)\.message|instanceof Error \? (e|err|error)\.message|\?\? e\.message|return e instanceof Error \? e\.message/;
    for (const f of OWN_TOASTS) expect(src(f), f).not.toMatch(raw);
  });

  it("🔴 W5/W6/W9: the journal entry shows each line's party and its status in words; the hint names the rule missed", () => {
    const s = src("pages/JournalEntries.tsx");
    expect(s).toContain("linePartyText(");
    expect(s).toContain("journalStatusLabel(");
    expect(s).not.toMatch(/>\{(e|selectedEntry)\.status\}<\/Badge>/);
    expect(s).toContain("partyHint(");
  });

  it("🔴 W8: the journal list's paging is on the page — after the new-entry dialog closes — not inside it", () => {
    const s = src("pages/JournalEntries.tsx");
    const dialogEnd = s.indexOf("</DialogContent>");
    const paging = s.indexOf("`Showing ${jePageInfo.offset + 1}");
    expect(dialogEnd).toBeGreaterThan(0);
    expect(paging).toBeGreaterThan(dialogEnd);
  });

  it("🔴 W7: the change-then-pay heading counts its days with Arabic agreement", () => {
    expect(src("components/ControlSettingsSection.tsx")).not.toContain("${f.windowDays} يوماً");
    expect(src("components/ControlSettingsSection.tsx")).toContain("daysAr(");
  });

  it("🔴 W11: the asset's VAT class is a word, and its schedule's period never wraps into the amount", () => {
    const s = src("pages/AssetDetail.tsx");
    expect(s).not.toContain("`${asset.vatCapitalAssetClass} ·");
    expect(s).toMatch(/whitespace-nowrap[^>]*dir="ltr">\{r\.period\}/);
  });
});
