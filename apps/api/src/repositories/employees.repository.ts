/** Employees repository — tenant-scoped via RLS. */
import { db, employeesTable } from "@workspace/db";
import { businessToday, gosiRatesFor, GOSI_IN_KIND_HOUSING_MONTHS_A_YEAR, GOSI_WAGE_CEILING, type GosiRegime } from "@workspace/shared";
import { and, eq, ilike, sql } from "drizzle-orm";
import { DEFAULT_PAGE } from "../lib/httpParams";

export interface EmployeeListFilter {
  search?: string;
  status?: string;
  department?: string;
  limit?: number;
  offset?: number;
}

/** One predicate for the rows AND the totals — so they cannot describe different sets. */
function employeeListConditions(filter: EmployeeListFilter) {
  const conditions = [];
  if (filter.search) conditions.push(ilike(employeesTable.name, `%${filter.search}%`));
  if (filter.status) conditions.push(eq(employeesTable.status, filter.status));
  if (filter.department) conditions.push(eq(employeesTable.department, filter.department));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const employeesRepository = {
  list(filter: EmployeeListFilter) {
    return db
      .select()
      .from(employeesTable)
      .where(employeeListConditions(filter))
      .orderBy(employeesTable.name)
      .limit(filter.limit ?? DEFAULT_PAGE)
      .offset(filter.offset ?? 0);
  },

  /**
   * 🔴 Headcount and payroll cost over every matching employee — never the page.
   *
   * Gross and GOSI are DERIVED here in SQL with the same formulas the row view
   * uses, because the columns store the components rather than the results.
   * The rates are BOUND from @workspace/shared's single definition (2026-09-14
   * — this used to be the flagged second statement of the rule; now a rate
   * change edits one file and this query follows).
   *
   * 🔴 GOSI (Phase 18, 2026-10-26): the employer share is the CURRENT period's
   * rate for each employee's regime, on basic + housing capped at SAR 45,000. A
   * Saudi employee whose law is not stated has no figure: they are COUNTED in
   * `gosiUnstatedCount` and left out of the sum, so the total never reads as
   * complete when it is not.
   *
   * 🔴 GO-10/GO-13 (Phase 18, 2026-10-27): the wage includes in-kind housing's
   * value, and a regime whose entry has a pension floor adds the employer's
   * pension rate on what the wage falls short of it — `gosiLineAmounts`' rule,
   * every number bound from the same entry. The employee previews and this total
   * are compared figure for figure by `phase18-gosi-go10-go13.test.ts`.
   */
  async listTotals(filter: EmployeeListFilter) {
    const gross = sql`(${employeesTable.basicSalary} + ${employeesTable.housingAllowance}
      + ${employeesTable.transportAllowance} + ${employeesTable.otherAllowances})`;
    const period = businessToday().slice(0, 7);
    const inKind = sql`(CASE WHEN ${employeesTable.gosiInKindHousing} AND NOT ${employeesTable.gosiInKindHousingExempt}
      THEN ROUND(${employeesTable.basicSalary} * ${GOSI_IN_KIND_HOUSING_MONTHS_A_YEAR}::numeric / 12, 2) ELSE 0 END)`;
    const wage = sql`LEAST(${employeesTable.basicSalary} + ${employeesTable.housingAllowance} + ${inKind}, ${GOSI_WAGE_CEILING})`;
    const employerOf = (r: GosiRegime) => {
      const rates = gosiRatesFor(r, period);
      if (!rates) return sql`NULL::numeric`;
      const floor = rates.entry.pensionFloorWage ?? 0;
      return sql`(${wage} * ${rates.employerRate}::numeric + GREATEST(${floor}::numeric - ${wage}, 0) * ${rates.entry.employer.pension}::numeric)`;
    };
    const gosiEmployer = sql`(CASE
      WHEN ${employeesTable.nationality} IS DISTINCT FROM 'SA' THEN ${employerOf("non_saudi")}
      WHEN ${employeesTable.gosiRegime} = 'law_1421h' THEN ${employerOf("law_1421h")}
      WHEN ${employeesTable.gosiRegime} = 'law_2024' THEN ${employerOf("law_2024")}
      ELSE NULL END)`;
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        saudiCount: sql<number>`COUNT(*) FILTER (WHERE ${employeesTable.nationality} = 'SA')::int`,
        grossSalary: sql<number>`COALESCE(SUM(${gross}), 0)::float8`,
        gosiEmployer: sql<number>`COALESCE(SUM(${gosiEmployer}), 0)::float8`,
        gosiUnstatedCount: sql<number>`COUNT(*) FILTER (WHERE ${gosiEmployer} IS NULL)::int`,
      })
      .from(employeesTable)
      .where(employeeListConditions(filter));
    return {
      total: Number(row?.total ?? 0),
      saudiCount: Number(row?.saudiCount ?? 0),
      grossSalary: Number(row?.grossSalary ?? 0),
      gosiEmployer: Number(row?.gosiEmployer ?? 0),
      gosiUnstatedCount: Number(row?.gosiUnstatedCount ?? 0),
    };
  },
  findById(id: number) {
    return db.select().from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
  },
  insert(values: typeof employeesTable.$inferInsert) {
    return db.insert(employeesTable).values(values).returning();
  },
  update(id: number, values: Partial<typeof employeesTable.$inferInsert>) {
    return db.update(employeesTable).set(values).where(eq(employeesTable.id, id)).returning();
  },
  remove(id: number) {
    return db.delete(employeesTable).where(eq(employeesTable.id, id));
  },
};
