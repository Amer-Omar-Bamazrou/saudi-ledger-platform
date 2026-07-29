/** Payroll repository — tenant-scoped via RLS. */
import { db, payrollRunsTable, payrollItemsTable, employeesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

export const payrollRepository = {
  listRuns() {
    return db.select().from(payrollRunsTable).orderBy(desc(payrollRunsTable.period));
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
