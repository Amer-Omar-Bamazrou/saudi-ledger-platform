/**
 * 🔴 DR-41 (Phase 18; owner decision 2.9, 2026-10-20; severity HIGH) — A SALARY
 * LINE NEVER EXPENSES SALARIES A SECOND TIME.
 *
 * Approving a payroll run already expenses the gross (Dr SALARIES / Cr
 * SALARIES_PAYABLE). The categoriser's salary rules pre-assigned the bank line
 * that pays the net to the SALARIES EXPENSE at 0.92, so "accept ready" posted
 * the salaries a second time and left the payable open (reproduced: SALARIES
 * 19,025.00 against a gross of 10,000.00). Where the company runs payroll:
 *  - a salary line the open payable can absorb is suggested against
 *    SALARIES_PAYABLE (accepting it pays the run: Dr payable / Cr bank);
 *  - otherwise it is NOT suggested at all — neither the expense (a second
 *    expense) nor the payable (paying more than is owed) — and waits for a
 *    person.
 * A company that does not run payroll keeps today's suggestion: there, the bank
 * line IS the salary expense.
 *
 * One function for every caller of the categoriser, so the rule cannot differ
 * between the upload and the Categorize page.
 */
import type { CategorizationMatch } from "./categorizer";

export interface PayrollSalaryContext {
  /** An approved or paid payroll run exists in this company. */
  usesPayroll: boolean;
  /** Net pay its runs still owe and no statement line is already waiting against. Decremented by the caller. */
  openPayable: number;
  /** 🔴 GOSI (Phase 18): GOSI contributions its runs still owe, on the same definition. Decremented by the caller. */
  openGosiPayable: number;
}

/**
 * 🔴 GOSI (Phase 18, owner 2026-10-26 night) — the same rule for a GOSI bank line. Approving a run already
 * expensed the employer share (Dr GOSI_EXPENSE) and withheld the employee share, both into GOSI_PAYABLE; a GOSI
 * line suggested against GOSI_EXPENSE would expense the employer share a second time and leave the payable open.
 * Where the company runs payroll it is suggested against GOSI_PAYABLE if the open payable can absorb it, and
 * otherwise not suggested at all.
 */
export function payrollAwareSalary(match: CategorizationMatch | null, amount: number, ctx: PayrollSalaryContext | null): CategorizationMatch | null {
  if (!match || !ctx?.usesPayroll) return match;
  if (match.systemCode === "SALARIES") {
    if (ctx.openPayable + 0.005 >= amount) {
      return {
        ...match,
        systemCode: "SALARIES_PAYABLE",
        categoryName: "Salaries Payable",
        categoryNameAr: "الرواتب المستحقة",
        matchedRule: `${match.matchedRule} — paying an approved payroll run`,
      };
    }
    return null;
  }
  if (match.systemCode === "GOSI_EXPENSE") {
    if (ctx.openGosiPayable + 0.005 >= amount) {
      return {
        ...match,
        systemCode: "GOSI_PAYABLE",
        categoryName: "GOSI Payable",
        categoryNameAr: "التأمينات الاجتماعية المستحقة",
        matchedRule: `${match.matchedRule} — paying an approved payroll run's GOSI`,
      };
    }
    return null;
  }
  return match;
}
