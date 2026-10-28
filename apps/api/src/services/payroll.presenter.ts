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
  // GOSI decision 22: what GOSI invoiced, and its difference from the accrual — a reconciling item, never posted.
  gosiInvoicedAmount: r.gosiInvoicedAmount == null ? null : Number(r.gosiInvoicedAmount),
  gosiInvoiceReference: r.gosiInvoiceReference ?? null,
  gosiReconcilingDifference: r.gosiInvoicedAmount == null ? null : Math.round((Number(r.gosiInvoicedAmount) - toNum(r.totalGosiEmployee) - toNum(r.totalGosiEmployer)) * 100) / 100,
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
  // GOSI (Phase 18): what the line was computed with; null on lines from before migration 0127.
  gosiWageBase: i.gosiWageBase == null ? null : Number(i.gosiWageBase),
  gosiEmployeeRate: i.gosiEmployeeRate == null ? null : Number(i.gosiEmployeeRate),
  gosiEmployerRate: i.gosiEmployerRate == null ? null : Number(i.gosiEmployerRate),
  // GO-10..GO-13 (Phase 18): null where the rule did not apply, and on lines from before migration 0128.
  gosiInKindHousing: i.gosiInKindHousing == null ? null : Number(i.gosiInKindHousing),
  gosiPensionFloorWage: i.gosiPensionFloorWage == null ? null : Number(i.gosiPensionFloorWage),
  additions: toNum(i.additions),
  deductions: toNum(i.deductions),
  netPay: toNum(i.netPay),
});

export type PayrollRunOut = ReturnType<typeof runToOut>;
