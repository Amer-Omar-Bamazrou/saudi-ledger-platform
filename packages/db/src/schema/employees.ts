import { pgTable, serial, text, boolean, timestamp, numeric, uuid, index, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const employeesTable = pgTable(
  "employees",
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
    employeeNumber: text("employee_number").notNull(),
    name: text("name").notNull(),
    nameAr: text("name_ar"),
    nationalId: text("national_id"),        // Saudi ID / Iqama number
    nationality: text("nationality").default("SA"),
    jobTitle: text("job_title"),
    jobTitleAr: text("job_title_ar"),
    department: text("department"),
    basicSalary: numeric("basic_salary", { precision: 15, scale: 2 }).notNull(),
    housingAllowance: numeric("housing_allowance", { precision: 15, scale: 2 }).default("0"),
    transportAllowance: numeric("transport_allowance", { precision: 15, scale: 2 }).default("0"),
    otherAllowances: numeric("other_allowances", { precision: 15, scale: 2 }).default("0"),
    gosiNumber: text("gosi_number"),
    /**
     * 🔴 GOSI (Phase 18, 2026-10-26): which Social Insurance law a SAUDI employee
     * contributes under — 'law_1421h' or 'law_2024'. Set by the employer FROM
     * CONTRIBUTION HISTORY, never from the hire date. NULL = not stated: a payroll
     * run that includes a Saudi employee without it is refused, never defaulted.
     * CHECK `employees_gosi_regime_chk` (migration 0127, hand-written).
     */
    gosiRegime: text("gosi_regime"),
    gosiRegimeSetBy: integer("gosi_regime_set_by"),
    gosiRegimeSetAt: timestamp("gosi_regime_set_at", { withTimezone: true }),
    gosiRegimeBasis: text("gosi_regime_basis"),
    /**
     * 🔴 GO-13 (Phase 18, owner 2026-10-27): housing is provided IN KIND, so its
     * value counts in the GOSI contributory wage (1421H Regulation Art. 16(c);
     * 2024 Regulation Art. 17(c)) — `gosiInKindHousingValue` in @workspace/shared.
     * EXEMPT = a case the Governor has exempted (it then adds nothing); only
     * meaningful with in-kind housing — CHECK `employees_gosi_in_kind_exempt_chk`
     * (migration 0128, hand-written).
     */
    gosiInKindHousing: boolean("gosi_in_kind_housing").notNull().default(false),
    gosiInKindHousingExempt: boolean("gosi_in_kind_housing_exempt").notNull().default(false),
    iban: text("iban"),
    bank: text("bank"),
    joiningDate: text("joining_date"),
    endDate: text("end_date"),
    status: text("status").notNull().default("active"), // active | inactive | terminated
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("employees_org_idx").on(t.organizationId)],
);

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
