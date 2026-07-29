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
 */
import { postJournalEntry } from "./accounting/glPosting";
import { payrollRepository } from "../repositories/payroll.repository";
import { runToOut, toNum, type PayrollRunOut } from "./payroll.presenter";
import type { Approvable, ApprovalState } from "./approval";
import type { payrollRunsTable } from "@workspace/db";

type PayrollRun = typeof payrollRunsTable.$inferSelect;

/** The run's on-approve action: the existing payroll GL posting, unchanged. */
async function postPayrollGL(run: PayrollRun): Promise<PayrollRunOut> {
  const gross = toNum(run.totalBasicSalary) + toNum(run.totalAllowances);
  const gosiEmp = toNum(run.totalGosiEmployee);
  const gosiEr = toNum(run.totalGosiEmployer);
  const netPay = toNum(run.totalNetPay);
  const approveDate = new Date().toISOString().split("T")[0];

  await postJournalEntry({
    entryNumber: `PAY-${run.period}`,
    date: approveDate,
    description: `Payroll run for period ${run.period}`,
    reference: `Payroll-${run.id}`,
    lines: [
      { accountName: "Salaries and Wages Expense", description: `Gross salaries ${run.period}`, debitAmount: gross, creditAmount: 0 },
      { accountName: "GOSI Expense - Employer", description: `Employer GOSI ${run.period}`, debitAmount: gosiEr, creditAmount: 0 },
      { accountName: "Salaries Payable", description: `Net pay payable ${run.period}`, debitAmount: 0, creditAmount: netPay },
      { accountName: "GOSI Payable", description: `GOSI payable ${run.period}`, debitAmount: 0, creditAmount: gosiEmp + gosiEr },
    ],
  });

  const [approved] = await payrollRepository.updateRun(run.id, {
    status: "approved",
    processedAt: new Date(),
    reviewNote: null,
  });
  return runToOut(approved);
}

export function payrollApprovable(): Approvable<PayrollRun, PayrollRunOut> {
  return {
    entityType: "payroll_run",

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

    onApprove(run) {
      return postPayrollGL(run);
    },

    async onSubmit(run) {
      const [updated] = await payrollRepository.updateRun(run.id, { status: "submitted", reviewNote: null });
      return runToOut(updated);
    },

    async onSendBack(run, _actor, note) {
      const [updated] = await payrollRepository.updateRun(run.id, {
        status: "draft",
        reviewNote: note?.trim() ? note.trim() : null,
      });
      return runToOut(updated);
    },

    async hardDelete(run) {
      await payrollRepository.deleteRun(run.id);
    },
  };
}
