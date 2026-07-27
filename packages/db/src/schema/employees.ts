import { pgTable, serial, text, boolean, timestamp, numeric, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const employeesTable = pgTable("employees", {
  id: serial("id").primaryKey(),
  // Multi-tenancy (M2, additive) — nullable until M3 backfill + enforcement.
  organizationId: uuid("organization_id").references(() => organizationsTable.id),
  companyId: uuid("company_id").references(() => companiesTable.id),
  employeeNumber: text("employee_number").notNull(),
  name: text("name").notNull(),
  nameAr: text("name_ar").notNull().default("(not yet translated)"),
  nationalId: text("national_id"),        // Saudi ID / Iqama number
  nationality: text("nationality").default("SA"),
  jobTitle: text("job_title"),
  jobTitleAr: text("job_title_ar").notNull().default("(not yet translated)"),
  department: text("department"),
  basicSalary: numeric("basic_salary", { precision: 15, scale: 2 }).notNull(),
  housingAllowance: numeric("housing_allowance", { precision: 15, scale: 2 }).default("0"),
  transportAllowance: numeric("transport_allowance", { precision: 15, scale: 2 }).default("0"),
  otherAllowances: numeric("other_allowances", { precision: 15, scale: 2 }).default("0"),
  gosiNumber: text("gosi_number"),
  iban: text("iban"),
  bank: text("bank"),
  joiningDate: text("joining_date"),
  endDate: text("end_date"),
  status: text("status").notNull().default("active"), // active | inactive | terminated
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEmployeeSchema = createInsertSchema(employeesTable)
  .omit({ id: true, createdAt: true })
  .extend({
    basicSalary: z.string().or(z.number()),
    housingAllowance: z.string().or(z.number()).optional(),
    transportAllowance: z.string().or(z.number()).optional(),
    otherAllowances: z.string().or(z.number()).optional(),
  });

export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employeesTable.$inferSelect;
