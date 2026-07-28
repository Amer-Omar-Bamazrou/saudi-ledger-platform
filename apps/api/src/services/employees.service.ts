/**
 * Employees service — GOSI (Saudi social insurance) computation + view.
 * GOSI rates preserved exactly: Saudi nationals 9.75% employee / 11.75% employer;
 * expats 0% / 2%. Behavior unchanged from pre-M6.
 */
import { NotFoundError } from "../lib/errors";
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
    const values = {
      ...data,
      basicSalary: String(data.basicSalary),
      housingAllowance: String(data.housingAllowance ?? 0),
      transportAllowance: String(data.transportAllowance ?? 0),
      otherAllowances: String(data.otherAllowances ?? 0),
    } as typeof employeesTable.$inferInsert;
    const [row] = await employeesRepository.insert(values);
    return toView(row);
  },

  async update(id: number, data: Record<string, unknown>) {
    const updates = { ...data } as Record<string, unknown>;
    if (updates.basicSalary != null) updates.basicSalary = String(updates.basicSalary);
    if (updates.housingAllowance != null) updates.housingAllowance = String(updates.housingAllowance);
    if (updates.transportAllowance != null) updates.transportAllowance = String(updates.transportAllowance);
    const [row] = await employeesRepository.update(id, updates as Partial<typeof employeesTable.$inferInsert>);
    if (!row) throw new NotFoundError("Not found");
    return toView(row);
  },

  async remove(id: number) {
    await employeesRepository.remove(id);
  },
};
