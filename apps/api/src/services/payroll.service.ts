/**
 * Payroll service — run generation (GOSI computed per employee) and approval,
 * which posts the payroll GL entry via services/accounting/glPosting (UNCHANGED).
 * GOSI rates + all arithmetic preserved exactly from the pre-M6 route.
 */
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors";
import { postJournalEntry } from "./accounting/glPosting";
import { payrollRepository } from "../repositories/payroll.repository";
import type { payrollRunsTable, payrollItemsTable } from "@workspace/db";

type PayrollRun = typeof payrollRunsTable.$inferSelect;
type PayrollItem = typeof payrollItemsTable.$inferSelect;
const toNum = (v: unknown) => (v != null ? Number(v) : 0);

const runToOut = (r: PayrollRun) => ({
  ...r,
  totalBasicSalary: toNum(r.totalBasicSalary),
  totalAllowances: toNum(r.totalAllowances),
  totalGosiEmployee: toNum(r.totalGosiEmployee),
  totalGosiEmployer: toNum(r.totalGosiEmployer),
  totalDeductions: toNum(r.totalDeductions),
  totalNetPay: toNum(r.totalNetPay),
});

const itemToOut = (i: PayrollItem) => ({
  ...i,
  basicSalary: toNum(i.basicSalary),
  housingAllowance: toNum(i.housingAllowance),
  transportAllowance: toNum(i.transportAllowance),
  otherAllowances: toNum(i.otherAllowances),
  grossSalary: toNum(i.grossSalary),
  gosiEmployee: toNum(i.gosiEmployee),
  gosiEmployer: toNum(i.gosiEmployer),
  additions: toNum(i.additions),
  deductions: toNum(i.deductions),
  netPay: toNum(i.netPay),
});

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
    return runToOut(run);
  },

  async approve(id: number) {
    const [run] = await payrollRepository.findRun(id);
    if (!run) throw new NotFoundError("Not found");
    if (run.status === "approved") throw new ConflictError("Payroll run is already approved.");

    const gross = toNum(run.totalBasicSalary) + toNum(run.totalAllowances);
    const gosiEmp = toNum(run.totalGosiEmployee);
    const gosiEr = toNum(run.totalGosiEmployer);
    const netPay = toNum(run.totalNetPay);
    const approveDate = new Date().toISOString().split("T")[0];

    // ── GL: Payroll expense entry ──
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

    const [approved] = await payrollRepository.updateRun(id, { status: "approved", processedAt: new Date() });
    return runToOut(approved);
  },
};
