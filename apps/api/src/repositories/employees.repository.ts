/** Employees repository — tenant-scoped via RLS. */
import { db, employeesTable } from "@workspace/db";
import { and, eq, ilike } from "drizzle-orm";

export interface EmployeeListFilter {
  search?: string;
  status?: string;
  department?: string;
}

export const employeesRepository = {
  list(filter: EmployeeListFilter) {
    const conditions = [];
    if (filter.search) conditions.push(ilike(employeesTable.name, `%${filter.search}%`));
    if (filter.status) conditions.push(eq(employeesTable.status, filter.status));
    if (filter.department) conditions.push(eq(employeesTable.department, filter.department));
    return db
      .select()
      .from(employeesTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(employeesTable.name);
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
