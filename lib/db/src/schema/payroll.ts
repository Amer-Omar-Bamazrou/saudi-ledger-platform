import { pgTable, serial, text, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { employeesTable } from "./employees";

export const payrollRunsTable = pgTable("payroll_runs", {
  id: serial("id").primaryKey(),
  period: text("period").notNull(),       // YYYY-MM
  status: text("status").notNull().default("draft"), // draft | approved | paid
  totalBasicSalary: numeric("total_basic_salary", { precision: 15, scale: 2 }).default("0"),
  totalAllowances: numeric("total_allowances", { precision: 15, scale: 2 }).default("0"),
  totalGosiEmployee: numeric("total_gosi_employee", { precision: 15, scale: 2 }).default("0"),
  totalGosiEmployer: numeric("total_gosi_employer", { precision: 15, scale: 2 }).default("0"),
  totalDeductions: numeric("total_deductions", { precision: 15, scale: 2 }).default("0"),
  totalNetPay: numeric("total_net_pay", { precision: 15, scale: 2 }).default("0"),
  processedAt: timestamp("processed_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const payrollItemsTable = pgTable("payroll_items", {
  id: serial("id").primaryKey(),
  payrollRunId: integer("payroll_run_id").notNull().references(() => payrollRunsTable.id, { onDelete: "cascade" }),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id, { onDelete: "restrict" }),
  basicSalary: numeric("basic_salary", { precision: 15, scale: 2 }).notNull(),
  housingAllowance: numeric("housing_allowance", { precision: 15, scale: 2 }).default("0"),
  transportAllowance: numeric("transport_allowance", { precision: 15, scale: 2 }).default("0"),
  otherAllowances: numeric("other_allowances", { precision: 15, scale: 2 }).default("0"),
  grossSalary: numeric("gross_salary", { precision: 15, scale: 2 }).notNull(),
  // GOSI: employee pays 9.75%, employer pays 11.75% (Saudi nationals)
  gosiEmployee: numeric("gosi_employee", { precision: 15, scale: 2 }).default("0"),
  gosiEmployer: numeric("gosi_employer", { precision: 15, scale: 2 }).default("0"),
  additions: numeric("additions", { precision: 15, scale: 2 }).default("0"),
  deductions: numeric("deductions", { precision: 15, scale: 2 }).default("0"),
  netPay: numeric("net_pay", { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPayrollRunSchema = createInsertSchema(payrollRunsTable).omit({ id: true, createdAt: true });
export const insertPayrollItemSchema = createInsertSchema(payrollItemsTable).omit({ id: true, createdAt: true });
export type InsertPayrollRun = z.infer<typeof insertPayrollRunSchema>;
export type PayrollRun = typeof payrollRunsTable.$inferSelect;
export type PayrollItem = typeof payrollItemsTable.$inferSelect;
