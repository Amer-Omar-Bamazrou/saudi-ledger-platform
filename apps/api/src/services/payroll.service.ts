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

export const payrollService = {
  async list() {
    const rows = await payrollRepository.listRuns();
    return rows.map(runToOut);
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

  async create(body: { period?: string; notes?: string }, userId: number | null) {
    const { period, notes } = body;
    const employees = await payrollRepository.activeEmployees();
    if (employees.length === 0) throw new BadRequestError("No active employees found");

    let totalBasic = 0;
    let totalAllowances = 0;
    let totalGosiEmp = 0;
    let totalGosiEr = 0;
    let totalNet = 0;
    const items = employees.map((emp) => {
      const basic = toNum(emp.basicSalary);
      const housing = toNum(emp.housingAllowance);
      const transport = toNum(emp.transportAllowance);
      const other = toNum(emp.otherAllowances);
      const gross = basic + housing + transport + other;
      const isSaudi = emp.nationality === "SA";
      const gosiEmp = isSaudi ? basic * 0.0975 : 0;
      const gosiEr = isSaudi ? basic * 0.1175 : basic * 0.02;
      const net = gross - gosiEmp;
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
      totalBasicSalary: String(totalBasic.toFixed(2)),
      totalAllowances: String(totalAllowances.toFixed(2)),
      totalGosiEmployee: String(totalGosiEmp.toFixed(2)),
      totalGosiEmployer: String(totalGosiEr.toFixed(2)),
      totalDeductions: "0",
      totalNetPay: String(totalNet.toFixed(2)),
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
