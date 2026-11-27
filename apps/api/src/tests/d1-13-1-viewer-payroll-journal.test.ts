/**
 * 🔴 19B, D1 — QUESTION 13.1, ANSWERED (owner, 2026-11-26): "viewers keep reading payroll journal entries."
 *
 * A policy decision under D1, recorded here as a test so that changing it is a deliberate act:
 *
 *  - a viewer reads journal entries, and runs the journal-lines report data, with every amount and account of every
 *    entry `standard` — a payroll run's entry among them. There is no class and no source-type rule that sets payroll
 *    entries, or the payroll accounts, apart for any role.
 *  - 🔴 WHAT THIS LETS A VIEWER DO, SAID PLAINLY: derive RUN-LEVEL pay and GOSI figures. A payroll run posts gross to
 *    Salaries, the employer's GOSI to GOSI expense, net to Salaries payable and both GOSI shares to GOSI payable — so a
 *    run's gross, net and both GOSI shares are in its entry, a one-employee run gives that person's pay, and the change
 *    between two months gives a joiner's or a leaver's. ACCEPTED AS POLICY: the statements already show total salaries.
 *  - What stays withheld from a viewer is unchanged: each employee's own pay, the payslip lines, the basic/allowances
 *    split and the employee list's money totals (v4 §5.4 a–d).
 *
 * This test pins behaviour that already existed; it was not written red. It fails if a later change gives the journal
 * a payroll rule, or takes the journal from viewers, without restating this decision.
 * DB-free.
 */
import { describe, expect, it } from "vitest";
import { PERMISSION_MATRIX, fieldGrantAction, reportDatasetResource } from "@workspace/db";
import { FIELD_CLASS_TABLE } from "../lib/fieldClasses/classTable";
import { JOURNAL_LINES, columnClass } from "../lib/reports/datasets";
import { decide, NO_USE } from "../lib/reports/decide";

const grants = new Set(PERMISSION_MATRIX.map((r) => `${r.role}:${r.resource}:${r.action}`));
const viewer = (resource: string, action: string) => grants.has(`viewer:${resource}:${action}`);

describe("19B D1, 13.1 — viewers keep reading payroll journal entries (accepted as policy)", () => {
  it("🔴 a viewer reads journal entries and runs the journal-lines report data", () => {
    expect(viewer("journal_entries", "read")).toBe(true);
    expect(viewer(reportDatasetResource("journal_lines"), "run")).toBe(true);
    expect(decide(viewer, JOURNAL_LINES, "run", NO_USE).allowed).toBe(true);
  });

  it("🔴 every amount and account of an entry is standard for every role: no class sets a payroll entry apart", () => {
    for (const key of ["date", "entryNumber", "sourceType", "accountId", "accountCode", "accountName", "debit", "credit"]) {
      expect([key, columnClass(JOURNAL_LINES, key).cls]).toEqual([key, "standard"]);
    }
    for (const node of ["JournalEntry", "JournalEntryLine", "JournalLinesDatasetRow"]) {
      const spec = FIELD_CLASS_TABLE[node]!;
      // the one row rule on a journal row is the bank's own text; none reads the entry's source for payroll
      expect([node, Object.keys(spec.rowConditions ?? {})]).toEqual([node, ["description"]]);
      expect([node, spec.compensation ?? null]).toEqual([node, null]);
    }
  });

  it("what a viewer is still not given: each employee's pay (the compensation class on employees and payroll)", () => {
    expect(viewer("employees", fieldGrantAction("compensation", "read"))).toBe(false);
    expect(viewer("payroll", fieldGrantAction("compensation", "read"))).toBe(false);
  });
});
