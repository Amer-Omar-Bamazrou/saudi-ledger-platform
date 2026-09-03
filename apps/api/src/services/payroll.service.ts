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
import { BadRequestError, NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { approvalService } from "./approval";
import { payrollApprovable } from "./payroll.approvable";
import { runToOut, itemToOut, toNum } from "./payroll.presenter";
import { payrollRepository } from "../repositories/payroll.repository";
import { round2, money2 } from "../lib/money";

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
      const gosiEmp = round2(isSaudi ? basic * 0.0975 : 0);
      const gosiEr = round2(isSaudi ? basic * 0.1175 : basic * 0.02);
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
};
