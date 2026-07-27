import { pgTable, uuid, varchar, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";

/**
 * Departments — a cost-center subdivision. Optionally under a branch; can also
 * be company-level (branch_id null). Carries `company_id` and `organization_id`
 * for direct tenant scoping.
 *
 * Added in Milestone 2 (additive).
 */
export const departmentsTable = pgTable("departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  branchId: uuid("branch_id").references(() => branchesTable.id), // nullable — can be company-level
  companyId: uuid("company_id")
    .notNull()
    .references(() => companiesTable.id),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  name: varchar("name", { length: 255 }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDepartmentSchema = createInsertSchema(departmentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDepartment = z.infer<typeof insertDepartmentSchema>;
export type Department = typeof departmentsTable.$inferSelect;
