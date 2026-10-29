/**
 * 🔴 Phase 18 H-9 — DR-19 (D-19; register §11.56): a company's CONTROL SETTINGS,
 * a TYPED table — each control is a column with its own type and CHECK, so a
 * misspelt key or a wrong-typed value cannot be stored ("make the wrong thing
 * inexpressible"), rather than a free key in a flag store.
 *
 * 🔴 DR-21 (D-11): a threshold slot ships EMPTY and DISABLED — NULL is its only
 * starting value, and no default number exists anywhere. A tenant sets its own.
 *
 * One row per company, written on the first change (no row = every slot empty).
 * Each control arrives with its own column; a change of any is audited.
 */
import { pgTable, serial, uuid, integer, timestamp, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const companyControlSettingsTable = pgTable(
  "company_control_settings",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    /**
     * DR-23's finding (C-ALARM "a payment within N days of a bank-detail change"): N, in days. NULL = disabled,
     * the finding lists nothing.
     */
    bankChangePaymentWindowDays: integer("bank_change_payment_window_days"),
    updatedBy: integer("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("company_control_settings_company_unq").on(t.companyId),
    check("company_control_settings_bank_window_chk", sql`${t.bankChangePaymentWindowDays} is null or ${t.bankChangePaymentWindowDays} between 1 and 365`),
  ],
);

export type CompanyControlSettings = typeof companyControlSettingsTable.$inferSelect;
