/**
 * Employees service — GOSI (Saudi social insurance) computation + view.
 * GOSI rates preserved exactly: Saudi nationals 9.75% employee / 11.75% employer;
 * expats 0% / 2%. Behavior unchanged from pre-M6.
 */
import { NotFoundError } from "../lib/errors";
import { pick, assertAmount, assertDateString } from "../lib/writeGuards";

/** H1 allowlist — user-settable employee fields. */
const EMPLOYEE_FIELDS = [
  "employeeNumber", "name", "nameAr", "nationalId", "nationality", "jobTitle",
  "jobTitleAr", "department", "basicSalary", "housingAllowance", "transportAllowance",
  "otherAllowances", "gosiNumber", "iban", "bank", "joiningDate", "endDate", "status", "notes",
] as const;
import { auditService } from "./audit.service";
import { employeesRepository, type EmployeeListFilter } from "../repositories/employees.repository";
import type { employeesTable } from "@workspace/db";

type Employee = typeof employeesTable.$inferSelect;
const toNum = (v: unknown) => (v != null ? Number(v) : 0);

const toView = (e: Employee) => ({
  ...e,
  basicSalary: toNum(e.basicSalary),
  housingAllowance: toNum(e.housingAllowance),
  transportAllowance: toNum(e.transportAllowance),
  otherAllowances: toNum(e.otherAllowances),
  grossSalary:
    toNum(e.basicSalary) + toNum(e.housingAllowance) + toNum(e.transportAllowance) + toNum(e.otherAllowances),
  gosiEmployee: e.nationality === "SA" ? toNum(e.basicSalary) * 0.0975 : 0,
  gosiEmployer: e.nationality === "SA" ? toNum(e.basicSalary) * 0.1175 : toNum(e.basicSalary) * 0.02,
});

export const employeesService = {
  async list(filter: EmployeeListFilter) {
    const rows = await employeesRepository.list(filter);
    return rows.map(toView);
  },

  async getById(id: number) {
    const [row] = await employeesRepository.findById(id);
    if (!row) throw new NotFoundError("Not found");
    return toView(row);
  },

  async create(data: Record<string, unknown>) {
    // 🔴 H1/H2 — ALLOWLIST + validate. Negative salaries persisted and flowed
    // into payroll/GOSI math; `String(undefined)` → 500.
    const picked = pick<Record<string, unknown>>(data, EMPLOYEE_FIELDS);
    for (const f of ["joiningDate", "endDate"] as const) if (data[f] != null) assertDateString(data[f], f);
    const values = {
      ...picked,
      basicSalary: assertAmount(data.basicSalary, "basicSalary", { min: 0, allowZero: true }).toFixed(2),
      housingAllowance: assertAmount(data.housingAllowance ?? 0, "housingAllowance", { min: 0, allowZero: true }).toFixed(2),
      transportAllowance: assertAmount(data.transportAllowance ?? 0, "transportAllowance", { min: 0, allowZero: true }).toFixed(2),
      otherAllowances: assertAmount(data.otherAllowances ?? 0, "otherAllowances", { min: 0, allowZero: true }).toFixed(2),
    } as typeof employeesTable.$inferInsert;
    const [row] = await employeesRepository.insert(values);
    await auditService.created("employee", row.id, row);
    return toView(row);
  },

  async update(id: number, data: Record<string, unknown>) {
    const [before] = await employeesRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const updates = pick<Record<string, unknown>>(data, EMPLOYEE_FIELDS);
    for (const f of ["joiningDate", "endDate"] as const) if (updates[f] != null) assertDateString(updates[f], f);
    for (const f of ["basicSalary", "housingAllowance", "transportAllowance", "otherAllowances"] as const) {
      if (updates[f] != null) updates[f] = assertAmount(updates[f], f, { min: 0, allowZero: true }).toFixed(2);
    }
    const [row] = await employeesRepository.update(id, updates as Partial<typeof employeesTable.$inferInsert>);
    await auditService.updated("employee", id, before, row);
    return toView(row);
  },

  async remove(id: number) {
    const [before] = await employeesRepository.findById(id);
    await employeesRepository.remove(id);
    if (before) await auditService.deleted("employee", id, before);
  },
};
