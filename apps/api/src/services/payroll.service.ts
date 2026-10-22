/**
 * Payroll service — run generation (GOSI computed per employee) and the
 * draft/approval workflow (M10.5).
 *
 * The draft→submitted→approved transitions are delegated to the generic
 * {@link approvalService} via the {@link payrollApprovable} adapter — the same
 * engine journal entries, bills, and invoices use. Approval fires the run's
 * existing GL posting (via services/accounting/glPosting), unchanged. Payroll
 * has always been a two-step create→approve flow, so there is no
 * self-approve-on-create: `create` yields a draft for everyone.
 *
 * GOSI rates + all arithmetic preserved exactly from the pre-M6 route.
 */
import { BadRequestError, BusinessRuleError, NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { approvalService } from "./approval";
import { payrollApprovable } from "./payroll.approvable";
import { runToOut, itemToOut, toNum } from "./payroll.presenter";
import { payrollRepository } from "../repositories/payroll.repository";
import { round2, money2 } from "../lib/money";
import { GOSI_RATES, businessToday } from "@workspace/shared";
import { postJournalEntry } from "./accounting/glPosting";
import { assertBankAccount } from "./accounting/bankIdentity";
import { assertDateString } from "../lib/writeGuards";

export const payrollService = {
  async list() {
    const [rows, itemTotals] = await Promise.all([
      payrollRepository.listRuns(),
      payrollRepository.runItemTotals(),
    ]);
    const byRun = new Map(itemTotals.map((t) => [t.payrollRunId, t]));
    return rows.map((r) => {
      const t = byRun.get(r.id);
      return {
        ...runToOut(r),
        employeeCount: Number(t?.employeeCount ?? 0),
        grossSalary: Number(t?.grossSalary ?? 0),
      };
    });
  },

  async getById(id: number) {
    const [run] = await payrollRepository.findRun(id);
    if (!run) throw new NotFoundError("Not found");
    const items = await payrollRepository.itemsWithEmployee(id);
    return {
      ...runToOut(run),
      items: items.map((r) => ({
        ...itemToOut(r.item),
        employeeName: r.emp?.name ?? null,
        employeeNumber: r.emp?.employeeNumber ?? null,
      })),
    };
  },

  async create(body: { period: string; notes?: string | null }, userId: number | null) {
    const { period, notes } = body;
    const employees = await payrollRepository.activeEmployees();
    if (employees.length === 0) throw new BadRequestError("No active employees found");

    let totalBasic = 0;
    let totalAllowances = 0;
    let totalGosiEmp = 0;
    let totalGosiEr = 0;
    let totalNet = 0;
    /**
     * 🔴 N2 (2026-09-03): every per-employee figure is ROUNDED BEFORE it is
     * accumulated, so the run's headers equal the sum of the stored payslips
     * EXACTLY — the invoice path's "header = Σ rounded lines" rule
     * (invoices.service.create), which this file never received.
     *
     * The old shape accumulated raw `basic * 0.0975` while each payslip
     * stored `.toFixed(2)`, so header ≠ Σ payslips by up to a halala per
     * employee — and the GL, built from the headers, failed the balance check
     * for 10.3% of salary values (185/1,801 measured; basic 3,010 × 3 Saudi
     * employees is the worked example), surfacing as an opaque 500 on
     * approve. With rounded accumulation the GL balances BY CONSTRUCTION:
     * net_i = gross_i − gosiEmp_i holds exactly at 2dp per employee, so
     * Σnet = Σgross − ΣgosiEmp holds exactly for the headers too.
     */
    const items = employees.map((emp) => {
      const basic = toNum(emp.basicSalary);
      const housing = toNum(emp.housingAllowance);
      const transport = toNum(emp.transportAllowance);
      const other = toNum(emp.otherAllowances);
      const gross = round2(basic + housing + transport + other);
      const isSaudi = emp.nationality === "SA";
      const gosiEmp = round2(isSaudi ? basic * GOSI_RATES.saudiEmployee : 0);
      const gosiEr = round2(isSaudi ? basic * GOSI_RATES.saudiEmployer : basic * GOSI_RATES.nonSaudiEmployer);
      const net = round2(gross - gosiEmp);
      totalBasic += basic;
      totalAllowances += housing + transport + other;
      totalGosiEmp += gosiEmp;
      totalGosiEr += gosiEr;
      totalNet += net;
      return {
        employeeId: emp.id,
        basicSalary: String(basic.toFixed(2)),
        housingAllowance: String(housing.toFixed(2)),
        transportAllowance: String(transport.toFixed(2)),
        otherAllowances: String(other.toFixed(2)),
        grossSalary: String(gross.toFixed(2)),
        gosiEmployee: String(gosiEmp.toFixed(2)),
        gosiEmployer: String(gosiEr.toFixed(2)),
        additions: "0",
        deductions: "0",
        netPay: String(net.toFixed(2)),
      };
    });

    const [run] = await payrollRepository.insertRun({
      period,
      status: "draft",
      notes,
      // money2 = round2 then format: sheds the float dust of summing 2dp
      // doubles, so the stored header is the exact sum of the stored payslips.
      totalBasicSalary: money2(totalBasic),
      totalAllowances: money2(totalAllowances),
      totalGosiEmployee: money2(totalGosiEmp),
      totalGosiEmployer: money2(totalGosiEr),
      totalDeductions: "0",
      totalNetPay: money2(totalNet),
      createdBy: userId ?? null,
    } as Parameters<typeof payrollRepository.insertRun>[0]);
    await payrollRepository.insertItems(items.map((i) => ({ ...i, payrollRunId: run.id })));
    await auditService.created("payroll_run", run.id, run);
    return runToOut(run);
  },

  /** Submit a draft run into the approval queue (bookkeeper action). */
  submit(id: number, userId: number | null) {
    return approvalService.submit(payrollApprovable(), id, { userId: userId ?? null });
  },

  /** Send a submitted run back to the enterer for correction (approver action). */
  sendBack(id: number, note: string | undefined, userId: number | null) {
    return approvalService.sendBack(payrollApprovable(), id, { userId: userId ?? null }, note);
  },

  /** Reject (hard-delete) a non-approved run (approver action). */
  reject(id: number, userId: number | null) {
    return approvalService.reject(payrollApprovable(), id, { userId: userId ?? null });
  },

  /** Approve a run — posts the payroll GL entry (Dr Salaries+GOSI / Cr Net+GOSI Payable). */
  approve(id: number, userId: number | null) {
    return approvalService.approve(payrollApprovable(), id, { userId: userId ?? null });
  },

  /**
   * 🔴 DR-41 / DR-39 (Phase 18, owner decision 2.9) — PAY a run's net pay from a bank: Dr Salaries Payable / Cr the
   * bank's cash account. The approval already EXPENSED the salaries; there was no pay path, so the only way to
   * clear the payable was a bank line — which the categoriser booked to the EXPENSE, a second time (reproduced).
   * Paying never touches SALARIES. One payment per run: the run's row is locked, it must be `approved`, and it
   * becomes `paid` only from `approved`. It is refused while Salaries Payable no longer owes the net pay (a bank
   * line already paid it, or one is waiting in review against it — `salaryPayableContext`, the one definition the
   * categoriser also reads). Dated the PAYMENT's day (default today); the accrual's date is AQ-7's open question and
   * is not changed here. A closed period refuses through the posting seam (423).
   */
  async pay(id: number, body: { bankAccountId?: unknown; paidAt?: unknown }, userId: number | null) {
    const bankAccountId = await assertBankAccount(body.bankAccountId, { what: "the net pay left from" });
    const paidAt = body.paidAt == null || body.paidAt === "" ? businessToday() : assertDateString(body.paidAt, "paidAt");
    await payrollRepository.lockRun(id);
    const [run] = await payrollRepository.findRun(id);
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status === "paid") throw new BusinessRuleError(409, { code: "payroll_already_paid", error: `Payroll run ${run.period} is already paid.` });
    if (run.status !== "approved") {
      throw new BusinessRuleError(409, { code: "payroll_not_approved", error: `Payroll run ${run.period} is not approved yet; its salaries are not in the books, so there is nothing to pay. Approve it first.` });
    }
    const netPay = toNum(run.totalNetPay);
    const { openPayable } = await payrollRepository.salaryPayableContext();
    if (openPayable + 0.005 < netPay) {
      throw new BusinessRuleError(409, {
        code: "payroll_payable_already_settled",
        error: `Salaries Payable owes ${openPayable.toFixed(2)} (after statement lines waiting in review against it), less than this run's net pay of ${netPay.toFixed(2)}: a bank line has already paid it, or is waiting to. Nothing was recorded. Reconcile that line instead.`,
      });
    }
    const [paid] = await payrollRepository.updateRunIfStatus(id, "approved", { status: "paid" });
    if (!paid) throw new BusinessRuleError(409, { code: "payroll_not_approved", error: `Payroll run ${run.period} changed while it was being paid. Nothing was recorded — reload and try again.` });
    const entry = await postJournalEntry({
      entryNumber: `PAY-${run.period}-R${run.id}-NET`,
      date: paidAt,
      description: `Net pay for payroll run ${run.period}`,
      reference: `Payroll-${run.id}`,
      lines: [
        { systemCode: "SALARIES_PAYABLE", accountName: "Salaries Payable", description: `Net pay paid ${run.period}`, debitAmount: netPay, creditAmount: 0 },
        { bankAccountId, description: `Net pay ${run.period}`, debitAmount: 0, creditAmount: netPay },
      ],
    });
    await auditService.record({ action: "pay", entityType: "payroll_run", entityId: id, before: runToOut(run), after: { ...runToOut(paid), paidAt, bankAccountId, journalEntryId: entry?.id ?? null, by: userId } });
    return runToOut(paid);
  },
};
