/**
 * THE HAND-WRITTEN-INTERFACE RATCHET — the contract milestone's first commit.
 *
 * ── 🔴 THE ACCEPTANCE CRITERION THIS EXISTS TO MEET (owner, 2026-09-01) ────
 * > "The acceptance criterion isn't 'the 14 endpoints are in the spec' — it's
 * > that a hand-written interface on a money surface becomes impossible to
 * > add, or at least fails a check. If bringing the endpoints into the
 * > contract still leaves someone free to hand-write the next one, we've
 * > fixed instances again."
 *
 * The evidence is four instances of the same money defect in five weeks:
 * CreditNotes' fields, TrialBalance's `id`, AssetSchedule's NaN, and
 * PayrollReport's `month`. **#106 fixed the instances and the class regrew,
 * because the GENERATOR was still there** — every new page was free to declare
 * a response shape nobody checks, and TypeScript agreed with all of them
 * because it checks the declaration against the COMPONENT, never the response.
 *
 * ── WHAT THE RATCHET DOES ──────────────────────────────────────────────────
 * The generator is the ability to add a NEW page that pairs `apiFetch` with a
 * locally-declared interface. This test inventories every file that does that
 * today, pins the list, and fails when a file JOINS it — so the next
 * hand-written interface fails CI on the commit that adds it, with a message
 * saying what to do instead.
 *
 * The pinned list is not a to-do disguised as a test: it is the measured size
 * of the debt (the milestone burns it down, and entries LEAVE as pages move to
 * the generated client — the stale-entry assertion forces that). It is the
 * same ratchet shape as the cross-company list and P4's known-gaps, and like
 * them it can only shrink.
 *
 * 🔴 "Impossible to add" in the strict sense would need the endpoint to exist
 * in the contract first — that is the milestone's remaining work. Until then,
 * "fails a check" is what this delivers, which is the criterion's floor.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, "../../../web/src");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "ui" || name === "generated") continue;
      walk(p, acc);
    } else if (name.endsWith(".tsx") || name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/** A file "hand-writes its contract" when it both calls apiFetch and declares an interface. */
function handWritesContract(src: string): boolean {
  return /\bapiFetch\b/.test(src) && /^\s*(?:export\s+)?interface\s+\w+/m.test(src);
}

const files = [...walk(join(WEB_SRC, "pages")), ...walk(join(WEB_SRC, "components")), ...walk(join(WEB_SRC, "lib")), ...walk(join(WEB_SRC, "hooks")), ...walk(join(WEB_SRC, "contexts"))];

/**
 * 🔴 THE DEBT, MEASURED AND PINNED (2026-09-01). Every file below pairs
 * `apiFetch` with a locally-declared interface — a response shape nobody
 * checks. The milestone's job is to empty this list by moving each page onto
 * the generated client; a page leaves in the commit that migrates it.
 */
const KNOWN_HAND_WRITTEN: readonly string[] = [
  "components/AskYourBooks.tsx",
  "components/OrgSwitcher.tsx",
  "components/PaymentHistory.tsx",
  "lib/pagedList.ts",
  "pages/AcceptInvite.tsx",
  "pages/ApAging.tsx",
  "pages/Approvals.tsx",
  "pages/ArAging.tsx",
  "pages/AssetSchedule.tsx",
  "pages/Assets.tsx",
  "pages/AuditTrail.tsx",
  "pages/BalanceSheet.tsx",
  "pages/BankAccounts.tsx",
  "pages/Bills.tsx",
  "pages/Budgets.tsx",
  "pages/CashFlow.tsx",
  "pages/ClosedMonths.tsx",
  "pages/CompanySettings.tsx",
  "pages/CreditNotes.tsx",
  "pages/CustomerDetail.tsx",
  "pages/Customers.tsx",
  "pages/Dashboard.tsx",
  "pages/Employees.tsx",
  "pages/Findings.tsx",
  "pages/IncomeStatement.tsx",
  "pages/InvoiceSummary.tsx",
  "pages/Invoices.tsx",
  "pages/JournalEntries.tsx",
  "pages/OperatorReview.tsx",
  "pages/OperatorZatcaPanel.tsx",
  "pages/Payroll.tsx",
  "pages/PayrollReport.tsx",
  "pages/Products.tsx",
  "pages/PurchaseOrders.tsx",
  "pages/Quotations.tsx",
  "pages/Recurring.tsx",
  "pages/ScanReview.tsx",
  "pages/TransactionReview.tsx",
  "pages/TrialBalance.tsx",
  "pages/Upload.tsx",
  "pages/UserManagement.tsx",
  "pages/VendorDetail.tsx",
  "pages/Vendors.tsx",
  "pages/VerificationStatus.tsx",
  "pages/ZakatReport.tsx",
  "pages/ZatcaOnboarding.tsx",
  "pages/reports/AccountStatement.tsx",
  "pages/reports/AccountSummary.tsx",
  "pages/reports/ActivityReport.tsx",
  "pages/reports/AgingReports.tsx",
  "pages/reports/CustomerLedger.tsx",
  "pages/reports/GeneralLedger.tsx",
  "pages/reports/JournalReport.tsx",
  "pages/reports/OwnerEquity.tsx",
  "pages/reports/TaxJournalEntries.tsx",
];

const rel = (p: string) => p.replace(/\\/g, "/").replace(/^.*?web\/src\//, "");

describe("the hand-written-interface ratchet", () => {
  const current = files.filter((f) => handWritesContract(readFileSync(f, "utf8"))).map(rel).sort();

  it("the ratchet is not vacuous — the debt it pins is real", () => {
    expect(current.length).toBeGreaterThan(30);
    // And the detector detects: TrialBalance is a known member with a recorded
    // incident behind it.
    expect(current).toContain("pages/TrialBalance.tsx");
  });

  it("🔴 NO NEW FILE pairs apiFetch with a hand-written interface", () => {
    const added = current.filter((f) => !KNOWN_HAND_WRITTEN.includes(f));
    expect(
      added,
      "A new file declares its own response interface for an apiFetch call.\n" +
        "That interface is a claim about the response that NOTHING checks — \n" +
        "TypeScript validates it against the component, never against the API.\n" +
        "Four money defects came from exactly this in five weeks (CreditNotes,\n" +
        "TrialBalance, AssetSchedule, PayrollReport).\n" +
        "Instead: add the endpoint to packages/api-spec/openapi.yaml, run\n" +
        "`pnpm --filter @workspace/api-spec run codegen`, and consume the\n" +
        "generated client from @workspace/api-client-react.\n" +
        "🔴 Do NOT add the file to KNOWN_HAND_WRITTEN — the list only shrinks.",
    ).toEqual([]);
  });

  it("🔴 the pinned list only SHRINKS — a migrated page leaves in the commit that migrates it", () => {
    const stale = KNOWN_HAND_WRITTEN.filter((f) => !current.includes(f));
    expect(
      stale,
      "KNOWN_HAND_WRITTEN names files that no longer hand-write their contract " +
        "(migrated, or deleted). Remove them — a stale entry is cover for a " +
        "future regression.",
    ).toEqual([]);
  });
});
