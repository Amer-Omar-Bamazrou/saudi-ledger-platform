import { pgTable, serial, text, timestamp, integer, numeric, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { employeesTable } from "./employees";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const payrollRunsTable = pgTable(
  "payroll_runs",
  {
    id: serial("id").primaryKey(),
    // Multi-tenancy — enforced NOT NULL in M3 (migrations/0002).
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),
    period: text("period").notNull(),       // YYYY-MM
    // Draft/approval workflow (M10.5): draft = editable, not posted; submitted =
    // awaiting approval (locked); approved = posted to the GL (payroll expense).
    status: text("status").notNull().default("draft"), // draft | submitted | approved | paid
    // Correction note an approver leaves when sending a submitted run back to the
    // enterer; cleared on resubmit/approve (M10.5).
    reviewNote: text("review_note"),
    totalBasicSalary: numeric("total_basic_salary", { precision: 15, scale: 2 }).default("0"),
    totalAllowances: numeric("total_allowances", { precision: 15, scale: 2 }).default("0"),
    totalGosiEmployee: numeric("total_gosi_employee", { precision: 15, scale: 2 }).default("0"),
    totalGosiEmployer: numeric("total_gosi_employer", { precision: 15, scale: 2 }).default("0"),
    totalDeductions: numeric("total_deductions", { precision: 15, scale: 2 }).default("0"),
    totalNetPay: numeric("total_net_pay", { precision: 15, scale: 2 }).default("0"),
    processedAt: timestamp("processed_at"),
    notes: text("notes"),
    createdBy: integer("created_by"),    // FK to users.id (nullable for pre-auth records)
    /** 🔴 GOSI (Phase 18): the day the run's GOSI was paid through the GOSI pay path (YYYY-MM-DD); NULL = not paid that way. */
    gosiPaidAt: text("gosi_paid_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("payroll_runs_org_idx").on(t.organizationId)],
);

export const payrollItemsTable = pgTable(
  "payroll_items",
  {
    id: serial("id").primaryKey(),
    // Multi-tenancy — enforced NOT NULL in M3 (migrations/0002).
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),
    payrollRunId: integer("payroll_run_id").notNull().references(() => payrollRunsTable.id, { onDelete: "cascade" }),
    employeeId: integer("employee_id").notNull().references(() => employeesTable.id, { onDelete: "restrict" }),
    basicSalary: numeric("basic_salary", { precision: 15, scale: 2 }).notNull(),
    housingAllowance: numeric("housing_allowance", { precision: 15, scale: 2 }).default("0"),
    transportAllowance: numeric("transport_allowance", { precision: 15, scale: 2 }).default("0"),
    otherAllowances: numeric("other_allowances", { precision: 15, scale: 2 }).default("0"),
    grossSalary: numeric("gross_salary", { precision: 15, scale: 2 }).notNull(),
    // GOSI (Phase 18, 2026-10-26): computed from @workspace/shared `gosi.ts` on the
    // contributory wage; the four columns below record what each line USED.
    gosiEmployee: numeric("gosi_employee", { precision: 15, scale: 2 }).default("0"),
    gosiEmployer: numeric("gosi_employer", { precision: 15, scale: 2 }).default("0"),
    /**
     * 🔴 What this line was computed WITH (Phase 18): its regime, contributory
     * wage and rates. A later change to the table or to the employee's flag can
     * never change a line already computed. NULL on lines computed before
     * migration 0127 — never back-filled; such a run is refused at approval
     * until it is regenerated. CHECK `payroll_items_gosi_regime_chk` (0127).
     */
    gosiRegime: text("gosi_regime"),
    gosiWageBase: numeric("gosi_wage_base", { precision: 15, scale: 2 }),
    gosiEmployeeRate: numeric("gosi_employee_rate", { precision: 7, scale: 4 }),
    gosiEmployerRate: numeric("gosi_employer_rate", { precision: 7, scale: 4 }),
    /**
     * 🔴 GO-10..GO-13 (Phase 18, owner 2026-10-27): the rest of what the line
     * used, each NULL where its rule did not apply (and on every line computed
     * before migration 0128). CHECKs in 0128, hand-written.
     *  - in-kind housing: the value counted inside `gosiWageBase` (GO-13);
     *  - pension floor wage: the wage the pension share was charged on, when the
     *    actual wage was below it (GO-10, 1421H law);
     *  - service days / period days: a joining or leaving month charged by days
     *    (GO-12, 2024 law) — both or neither;
     *  - wage fixed period: the period whose line fixed the year's contributory
     *    wage, which this line used (GO-12, 1421H law).
     */
    gosiInKindHousing: numeric("gosi_in_kind_housing", { precision: 15, scale: 2 }),
    gosiPensionFloorWage: numeric("gosi_pension_floor_wage", { precision: 15, scale: 2 }),
    gosiServiceDays: integer("gosi_service_days"),
    gosiPeriodDays: integer("gosi_period_days"),
    gosiWageFixedPeriod: text("gosi_wage_fixed_period"),
    additions: numeric("additions", { precision: 15, scale: 2 }).default("0"),
    deductions: numeric("deductions", { precision: 15, scale: 2 }).default("0"),
    netPay: numeric("net_pay", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("payroll_items_org_run_idx").on(t.organizationId, t.payrollRunId)],
);

export const insertPayrollRunSchema = createInsertSchema(payrollRunsTable).omit({ id: true, createdAt: true });
export const insertPayrollItemSchema = createInsertSchema(payrollItemsTable).omit({ id: true, createdAt: true });
export type InsertPayrollRun = z.infer<typeof insertPayrollRunSchema>;
export type PayrollRun = typeof payrollRunsTable.$inferSelect;
export type PayrollItem = typeof payrollItemsTable.$inferSelect;
