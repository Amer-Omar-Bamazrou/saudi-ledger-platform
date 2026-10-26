/**
 * Employees service — GOSI (Saudi social insurance) computation + view.
 * GOSI comes from @workspace/shared `gosi.ts` (Phase 18, 2026-10-26): the
 * employee's law regime, the current period's rates, and the contributory wage
 * (basic + cash housing + in-kind housing's value, capped at SAR 45,000; GO-13),
 * with the 1421H-law pension floor (GO-10). A Saudi employee whose law is not
 * stated has NO preview figure (null), never a guessed one.
 */
import {
  businessToday, gosiContributoryWage, gosiInKindHousingValue, gosiLineAmounts, gosiRatesFor, GOSI_EMPLOYEE_REGIMES, type GosiRegime,
} from "@workspace/shared";
import { BusinessRuleError, NotFoundError } from "../lib/errors";
import { auditContext } from "../lib/auditContext";
import { round2 } from "../lib/money";
import { pick, assertAmount, assertDateString , nullifyEmptyText } from "../lib/writeGuards";

/** H1 allowlist — user-settable employee fields. */
const EMPLOYEE_FIELDS = [
  "employeeNumber", "name", "nameAr", "nationalId", "nationality", "jobTitle",
  "jobTitleAr", "department", "basicSalary", "housingAllowance", "transportAllowance",
  "otherAllowances", "gosiNumber", "iban", "bank", "joiningDate", "endDate", "status", "notes",
  "gosiRegime", "gosiRegimeBasis", "gosiInKindHousing", "gosiInKindHousingExempt",
] as const;

/**
 * 🔴 GO-13 (Phase 18, owner 2026-10-27): "exempt" is the Governor's exemption of IN-KIND housing, so it means
 * nothing without it — refused by name rather than stored (the database CHECK is the backstop).
 */
function assertInKindHousing(data: Record<string, unknown>, before: Employee | null) {
  const inKind = data.gosiInKindHousing === undefined ? (before?.gosiInKindHousing ?? false) : data.gosiInKindHousing === true;
  const exempt = data.gosiInKindHousingExempt === undefined ? (before?.gosiInKindHousingExempt ?? false) : data.gosiInKindHousingExempt === true;
  if (exempt && !inKind) {
    throw new BusinessRuleError(422, {
      code: "gosi_in_kind_exempt_without_in_kind",
      error: "An in-kind housing exemption needs in-kind housing: only housing the employer provides in kind can be exempted from GOSI. Set in-kind housing, or clear the exemption. Nothing was saved.",
      field: "gosiInKindHousingExempt",
    });
  }
}

/**
 * 🔴 GOSI (Phase 18): the law a Saudi employee contributes under is the employer's
 * statement, from contribution history. Validated here; who stated it and when
 * is recorded beside it whenever it changes. A non-Saudi employee carries none.
 */
function gosiRegimeFields(
  data: Record<string, unknown>,
  nationality: unknown,
  before: Employee | null,
): Partial<typeof employeesTable.$inferInsert> {
  if (!("gosiRegime" in data) && !("gosiRegimeBasis" in data)) return {};
  const regime = data.gosiRegime === undefined ? (before?.gosiRegime ?? null) : data.gosiRegime === "" ? null : data.gosiRegime;
  if (regime !== null && !(GOSI_EMPLOYEE_REGIMES as readonly unknown[]).includes(regime)) {
    throw new BusinessRuleError(422, { code: "gosi_regime_unknown", error: "The GOSI law is law_1421h (the 1421H law) or law_2024 (the 2024 law).", field: "gosiRegime" });
  }
  if (regime !== null && nationality !== "SA") {
    throw new BusinessRuleError(422, { code: "gosi_regime_not_applicable", error: "Only a Saudi employee has a GOSI law to state; a non-Saudi employee's GOSI is the employer's occupational-hazards share.", field: "gosiRegime" });
  }
  const basis = data.gosiRegimeBasis === undefined ? (before?.gosiRegimeBasis ?? null) : (typeof data.gosiRegimeBasis === "string" && data.gosiRegimeBasis.trim() ? data.gosiRegimeBasis.trim() : null);
  const changed = regime !== (before?.gosiRegime ?? null);
  return {
    gosiRegime: regime as string | null,
    gosiRegimeBasis: basis,
    ...(changed ? { gosiRegimeSetBy: auditContext.get()?.userId ?? null, gosiRegimeSetAt: new Date() } : {}),
  };
}
import { auditService } from "./audit.service";
import { employeesRepository, type EmployeeListFilter } from "../repositories/employees.repository";
import { DEFAULT_PAGE } from "../lib/httpParams";
import type { employeesTable } from "@workspace/db";

type Employee = typeof employeesTable.$inferSelect;
const toNum = (v: unknown) => (v != null ? Number(v) : 0);

/**
 * The GOSI preview for the CURRENT period, from the employee's own figures: in-kind housing and the pension floor
 * included (GO-10, GO-13); a fixed year's wage and a joining or leaving month's days are payroll facts, not
 * previewed. Null where the regime is not stated or its rate not established.
 */
function gosiPreview(e: Employee) {
  const regime: GosiRegime | null = e.nationality === "SA" ? ((e.gosiRegime as GosiRegime | null) ?? null) : "non_saudi";
  const rates = regime ? gosiRatesFor(regime, businessToday().slice(0, 7)) : null;
  if (!rates) return { gosiWageBase: null, gosiEmployee: null, gosiEmployer: null };
  const basic = toNum(e.basicSalary);
  const inKind = e.gosiInKindHousing && !e.gosiInKindHousingExempt ? round2(gosiInKindHousingValue(basic)) : 0;
  const wage = round2(gosiContributoryWage(basic, toNum(e.housingAllowance), inKind));
  const amounts = gosiLineAmounts({ rates, wage });
  return { gosiWageBase: wage, gosiEmployee: round2(amounts.employee), gosiEmployer: round2(amounts.employer) };
}

const toView = (e: Employee) => ({
  ...e,
  basicSalary: toNum(e.basicSalary),
  housingAllowance: toNum(e.housingAllowance),
  transportAllowance: toNum(e.transportAllowance),
  otherAllowances: toNum(e.otherAllowances),
  grossSalary:
    toNum(e.basicSalary) + toNum(e.housingAllowance) + toNum(e.transportAllowance) + toNum(e.otherAllowances),
  ...gosiPreview(e),
});

export const employeesService = {
  async list(filter: EmployeeListFilter) {
    const [rows, totals] = await Promise.all([
      employeesRepository.list(filter),
      employeesRepository.listTotals(filter),
    ]);
    const { total, ...headline } = totals;
    return {
      items: rows.map(toView),
      page: { limit: filter.limit ?? DEFAULT_PAGE, offset: filter.offset ?? 0, total },
      totals: headline,
    };
  },

  async getById(id: number) {
    const [row] = await employeesRepository.findById(id);
    if (!row) throw new NotFoundError("Not found");
    return toView(row);
  },

  async create(data: Record<string, unknown>) {
    // 🔴 H1/H2 — ALLOWLIST + validate. Negative salaries persisted and flowed
    // into payroll/GOSI math; `String(undefined)` → 500.
    const picked = nullifyEmptyText(pick<Record<string, unknown>>(data, EMPLOYEE_FIELDS), ["nameAr", "jobTitleAr"]);
    for (const f of ["joiningDate", "endDate"] as const) if (data[f] != null) assertDateString(data[f], f);
    assertInKindHousing(data, null);
    const values = {
      ...picked,
      basicSalary: assertAmount(data.basicSalary, "basicSalary", { min: 0, allowZero: true }).toFixed(2),
      housingAllowance: assertAmount(data.housingAllowance ?? 0, "housingAllowance", { min: 0, allowZero: true }).toFixed(2),
      transportAllowance: assertAmount(data.transportAllowance ?? 0, "transportAllowance", { min: 0, allowZero: true }).toFixed(2),
      otherAllowances: assertAmount(data.otherAllowances ?? 0, "otherAllowances", { min: 0, allowZero: true }).toFixed(2),
      ...gosiRegimeFields(data, picked.nationality ?? "SA", null),
    } as typeof employeesTable.$inferInsert;
    const [row] = await employeesRepository.insert(values);
    await auditService.created("employee", row.id, row);
    return toView(row);
  },

  async update(id: number, data: Record<string, unknown>) {
    const [before] = await employeesRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const updates = nullifyEmptyText(pick<Record<string, unknown>>(data, EMPLOYEE_FIELDS), ["nameAr", "jobTitleAr"]);
    for (const f of ["joiningDate", "endDate"] as const) if (updates[f] != null) assertDateString(updates[f], f);
    assertInKindHousing(updates, before);
    for (const f of ["basicSalary", "housingAllowance", "transportAllowance", "otherAllowances"] as const) {
      if (updates[f] != null) updates[f] = assertAmount(updates[f], f, { min: 0, allowZero: true }).toFixed(2);
    }
    const nationality = "nationality" in updates ? updates.nationality : before.nationality;
    // A Saudi turned non-Saudi loses the regime; a regime stated for a non-Saudi is refused below.
    const regimeInput = nationality !== "SA" && !("gosiRegime" in data) && before.gosiRegime ? { ...data, gosiRegime: null } : data;
    Object.assign(updates, gosiRegimeFields(regimeInput, nationality, before));
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
