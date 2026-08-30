/** Payroll repository — tenant-scoped via RLS. */
import { db, payrollRunsTable, payrollItemsTable, employeesTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";

export const payrollRepository = {
  listRuns() {
    return db.select().from(payrollRunsTable).orderBy(desc(payrollRunsTable.period));
  },
  /**
   * 🔴 Per-run headcount and gross, from the ITEM rows.
   *
   * A payroll run stores `total_basic_salary` and `total_allowances` but no
   * gross and no headcount, and the Payroll Report was reading `grossSalary`
   * and `employeeCount` off the run — fields no response contained. It also
   * filtered on `r.month`, which does not exist either, so `undefined >= "2026-01"`
   * was false for every row and **the report rendered empty whatever the tenant
   * had run**.
   *
   * Gross is SUMmed from `payroll_items.gross_salary` rather than added up from
   * the run's two header columns, per §4: when line-level truth exists,
   * header-level arithmetic is a second computation of the same fact and will
   * drift. GOSI is the two employer/employee headers, which ARE the stored
   * fact.
   */
  runItemTotals() {
    return db
      .select({
        payrollRunId: payrollItemsTable.payrollRunId,
        employeeCount: sql<number>`COUNT(*)::int`,
        grossSalary: sql<number>`COALESCE(SUM(${payrollItemsTable.grossSalary}), 0)::float8`,
      })
      .from(payrollItemsTable)
      .groupBy(payrollItemsTable.payrollRunId);
  },
  findRun(id: number) {
    return db.select().from(payrollRunsTable).where(eq(payrollRunsTable.id, id)).limit(1);
  },
  itemsWithEmployee(runId: number) {
    return db
      .select({ item: payrollItemsTable, emp: employeesTable })
      .from(payrollItemsTable)
      .leftJoin(employeesTable, eq(payrollItemsTable.employeeId, employeesTable.id))
      .where(eq(payrollItemsTable.payrollRunId, runId));
  },
  activeEmployees() {
    return db.select().from(employeesTable).where(eq(employeesTable.status, "active"));
  },
  insertRun(values: typeof payrollRunsTable.$inferInsert) {
    return db.insert(payrollRunsTable).values(values).returning();
  },
  insertItems(values: (typeof payrollItemsTable.$inferInsert)[]) {
    return db.insert(payrollItemsTable).values(values);
  },
  updateRun(id: number, values: Partial<typeof payrollRunsTable.$inferInsert>) {
    return db.update(payrollRunsTable).set(values).where(eq(payrollRunsTable.id, id)).returning();
  },
  // Reject (hard-delete) a non-approved run; payroll_items cascade on the FK.
  deleteRun(id: number) {
    return db.delete(payrollRunsTable).where(eq(payrollRunsTable.id, id));
  },
};
