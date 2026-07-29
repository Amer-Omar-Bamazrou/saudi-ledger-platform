/**
 * Payroll presenter — shapes a payroll run (and its items) into the API/audit
 * response object. Extracted from the service so the service and the approval
 * adapter share one shape without a circular import.
 */
import type { payrollRunsTable, payrollItemsTable } from "@workspace/db";

type PayrollRun = typeof payrollRunsTable.$inferSelect;
type PayrollItem = typeof payrollItemsTable.$inferSelect;

export const toNum = (v: unknown) => (v != null ? Number(v) : 0);

export const runToOut = (r: PayrollRun) => ({
  ...r,
  totalBasicSalary: toNum(r.totalBasicSalary),
  totalAllowances: toNum(r.totalAllowances),
  totalGosiEmployee: toNum(r.totalGosiEmployee),
  totalGosiEmployer: toNum(r.totalGosiEmployer),
  totalDeductions: toNum(r.totalDeductions),
  totalNetPay: toNum(r.totalNetPay),
});

export const itemToOut = (i: PayrollItem) => ({
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

export type PayrollRunOut = ReturnType<typeof runToOut>;
