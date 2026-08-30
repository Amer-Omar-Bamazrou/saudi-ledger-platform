/** Employees repository — tenant-scoped via RLS. */
import { db, employeesTable } from "@workspace/db";
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
   * 🔴 That is a second statement of one rule, and it is flagged rather than
   * hidden: if the GOSI rates change, both places change. Keeping them apart
   * was the alternative to summing a page, which is the worse of the two.
   */
  async listTotals(filter: EmployeeListFilter) {
    const gross = sql`(${employeesTable.basicSalary} + ${employeesTable.housingAllowance}
      + ${employeesTable.transportAllowance} + ${employeesTable.otherAllowances})`;
    const gosiEmployer = sql`(CASE WHEN ${employeesTable.nationality} = 'SA'
      THEN ${employeesTable.basicSalary} * 0.1175 ELSE ${employeesTable.basicSalary} * 0.02 END)`;
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        saudiCount: sql<number>`COUNT(*) FILTER (WHERE ${employeesTable.nationality} = 'SA')::int`,
        grossSalary: sql<number>`COALESCE(SUM(${gross}), 0)::float8`,
        gosiEmployer: sql<number>`COALESCE(SUM(${gosiEmployer}), 0)::float8`,
      })
      .from(employeesTable)
      .where(employeeListConditions(filter));
    return {
      total: Number(row?.total ?? 0),
      saudiCount: Number(row?.saudiCount ?? 0),
      grossSalary: Number(row?.grossSalary ?? 0),
      gosiEmployer: Number(row?.gosiEmployer ?? 0),
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
