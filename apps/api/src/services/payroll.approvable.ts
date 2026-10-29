/**
 * Payroll-run approval adapter — plugs payroll runs into the generic
 * {@link approvalService} (M10.5). Reuses the engine unchanged.
 *
 * A payroll run's only ledger effect is the GL entry posted at approval — no
 * report reads `payroll_runs` directly. So a draft/submitted run posts nothing
 * (zero movement), and `onApprove` runs the EXISTING payroll approve→GL path
 * (Dr Salaries + Employer GOSI / Cr Net Pay + GOSI Payable), unchanged.
 *
 * State mapping (spec §9, §10):
 *   draft     → draft      (editable-ish; not posted)
 *   submitted → submitted  (awaiting approval; not posted)
 *   approved  → approved   (posted to the GL)
 *   paid      → approved   (post-approval)
 *
 * 🔴 G08 residuals (PR A) — COMPARE-AND-SET. Every write applies only while the
 * run is still in the state the approval engine checked. B-G08R-P reproduced,
 * with these writes keyed on id only: a reject queued behind an approval
 * DELETED the approved run and left its posted entry; a send-back or submit
 * behind one set it back to draft or submitted, where a later reject deleted it.
 */
import { postJournalEntry } from "./accounting/glPosting";
import { BusinessRuleError, PeriodLockedError } from "../lib/errors";
import { checkPeriodOpen } from "./accounting/periodLock";
import { lastDayOf } from "./assets/depreciationSchedule";

/**
 * 🔴 G68 (register §11.51, §11.52): the date a payroll run is ACCRUED — the last day of its service period
 * (`run.period`, YYYY-MM). The ONE definition: the approval posts on it, and the obligations calendar owes a run's
 * GOSI from it, so the two cannot drift.
 */
export function payrollAccrualDate(period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new BusinessRuleError(422, { code: "payroll_period_invalid", error: `Payroll period ${JSON.stringify(period)} is not a YYYY-MM month.`, field: "period" });
  }
  return lastDayOf(period);
}
import { payrollRepository } from "../repositories/payroll.repository";
import { runToOut, toNum, type PayrollRunOut } from "./payroll.presenter";
import { checkedState, TransitionNotApplied, type Approvable, type ApprovalState } from "./approval";
import type { payrollRunsTable } from "@workspace/db";
import { businessToday } from "@workspace/shared";

type PayrollRun = typeof payrollRunsTable.$inferSelect;

/**
 * The run's on-approve action: the existing payroll GL posting, unchanged —
 * except that the run is CLAIMED first.
 *
 * 🔴 G08 residuals (PR A): the run becomes approved only while it is still in
 * the state the engine checked, and BEFORE anything posts, so an approval that
 * lost a race writes nothing at all. Claiming first is safe here: a payroll
 * run's row is locked only by its own transitions, none of which holds another
 * lock first, and the entry posted next is keyed on this run's id
 * (`PAY-<period>-R<id>`), so no other request can hold that key while waiting
 * for this row — no lock cycle can form. (Bills keep their status write where
 * it was: they lock a supplier payment or an original bill before their own
 * row.)
 */
async function postPayrollGL(run: PayrollRun, from: "draft" | "submitted"): Promise<PayrollRunOut> {
  /**
   * 🔴 GOSI (Phase 18, owner 2026-10-26 night): a run computed before the GOSI
   * table existed carries no record of the rates and wage it used, and its
   * figures are the old rule's (1421H rates on basic pay alone, no ceiling). It
   * is refused here, before anything is claimed or posted, until it is
   * regenerated. Approved and paid runs are never touched.
   */
  if ((await payrollRepository.itemsWithoutGosiSnapshot(run.id)) > 0) {
    throw new BusinessRuleError(422, {
      code: "payroll_run_regenerate_required",
      error:
        `Payroll run ${run.period} was computed before GOSI contributions were brought up to date (the law regime, ` +
        `basic pay plus housing up to SAR 45,000, the current rates), so it cannot be approved as it stands. Reject ` +
        `it and generate the run for ${run.period} again. Nothing was posted.`,
      period: run.period,
    });
  }
  /**
   * 🔴 Phase 18 H-5 — G68 (the owner's final-run memo §H; register §11.51; IAS 19.11): payroll is accrued on the
   * LAST DAY of its service period (`run.period`, YYYY-MM), never the approval day — a run approved in a later month
   * belongs to its own. When that month is closed, approval is refused here, before anything is written, with how
   * to correct it: reopen the month with a reason, approve the run, close the month again.
   */
  const accrualDate = payrollAccrualDate(run.period);
  try {
    await checkPeriodOpen(accrualDate);
  } catch (err) {
    if (!(err instanceof PeriodLockedError)) throw err;
    throw new BusinessRuleError(423, {
      code: "payroll_period_closed",
      error:
        `Payroll run ${run.period} is accrued on ${accrualDate}, the last day of the month it pays for, and ${run.period} is closed. ` +
        `To approve it, reopen ${run.period} with a reason (Closed months), approve the run, then close the month again. Nothing was posted.`,
      field: "period",
      period: run.period,
    });
  }
  const [approved] = await payrollRepository.updateRunIfStatus(run.id, from, {
    status: "approved",
    processedAt: new Date(),
    reviewNote: null,
  });
  if (!approved) throw new TransitionNotApplied();

  const gross = toNum(run.totalBasicSalary) + toNum(run.totalAllowances);
  const gosiEmp = toNum(run.totalGosiEmployee);
  const gosiEr = toNum(run.totalGosiEmployer);
  const netPay = toNum(run.totalNetPay);
  const approveDate = accrualDate; // G68: the service period's last day (above), not the approval day

  await postJournalEntry({ sourceType: "payroll_run", sourceId: run.id,
    // N3: suffixed with the run id — `PAY-<period>` alone collided the day a
    // period legitimately got a second run (a correction), and the unique
    // (company_id, entry_number) index would have made that approval a 500.
    entryNumber: `PAY-${run.period}-R${run.id}`,
    date: approveDate,
    description: `Payroll run for period ${run.period}`,
    reference: `Payroll-${run.id}`,
    lines: [
      { systemCode: "SALARIES", accountName: "Salaries and Wages Expense", description: `Gross salaries ${run.period}`, debitAmount: gross, creditAmount: 0 },
      { systemCode: "GOSI_EXPENSE", accountName: "GOSI Expense - Employer", description: `Employer GOSI ${run.period}`, debitAmount: gosiEr, creditAmount: 0 },
      { systemCode: "SALARIES_PAYABLE", accountName: "Salaries Payable", description: `Net pay payable ${run.period}`, debitAmount: 0, creditAmount: netPay },
      { systemCode: "GOSI_PAYABLE", accountName: "GOSI Payable", description: `GOSI payable ${run.period}`, debitAmount: 0, creditAmount: gosiEmp + gosiEr },
    ],
  });

  return runToOut(approved);
}

export function payrollApprovable(): Approvable<PayrollRun, PayrollRunOut> {
  return {
    entityType: "payroll_run",
    // 🔴 G08 residuals (PR A): every write below applies only from the state the engine checked.
    compareAndSet: true,

    async load(id) {
      const [run] = await payrollRepository.findRun(id);
      return run ?? null;
    },

    state(run): ApprovalState {
      if (run.status === "draft") return "draft";
      if (run.status === "submitted") return "submitted";
      return "approved";
    },

    snapshot(run) {
      return runToOut(run);
    },

    onApprove(run, _actor, from) {
      return postPayrollGL(run, checkedState(from));
    },

    async onSubmit(run) {
      const [updated] = await payrollRepository.updateRunIfStatus(run.id, "draft", { status: "submitted", reviewNote: null });
      if (!updated) throw new TransitionNotApplied();
      return runToOut(updated);
    },

    async onSendBack(run, _actor, note) {
      const [updated] = await payrollRepository.updateRunIfStatus(run.id, "submitted", {
        status: "draft",
        reviewNote: note?.trim() ? note.trim() : null,
      });
      if (!updated) throw new TransitionNotApplied();
      return runToOut(updated);
    },

    async hardDelete(run, from) {
      const [removed] = await payrollRepository.deleteRunIfStatus(run.id, checkedState(from));
      if (!removed) throw new TransitionNotApplied();
    },
  };
}
