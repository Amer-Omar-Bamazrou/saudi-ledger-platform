/**
 * 🔴 T1e (Phase 18; DR-10, DR-30 — owner 2026-10-24): the period records, all
 * APPEND-ONLY for the request's role (0130 grants SELECT and INSERT only).
 * DR-10: "build all the records it lists, append-only"; recording a fact
 * changes no current behaviour, except the one guard DR-30 decided: no month of
 * a fiscal year whose statements are authorised is reopened.
 *
 * None carries a tenant→tenant foreign key (the G04 ratchet): an amendment
 * names the filing it amends by its ZATCA reference.
 */
import { pgTable, serial, text, timestamp, integer, uuid, date, check, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

// The request's own tenant and company, as the newer tables default them (tax.ts). The records go with their
// company if an operator ever deletes it (no product path deletes a company); the request's role deletes none.
const tenant = () => ({
  organizationId: uuid("organization_id").notNull().default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`).references(() => organizationsTable.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`).references(() => companiesTable.id, { onDelete: "cascade" }),
});

/** PER-2: every close and reopen of a month, in order. A reopen carries its reason. */
export const periodLockEventsTable = pgTable(
  "period_lock_events",
  {
    id: serial("id").primaryKey(),
    ...tenant(),
    period: text("period").notNull(),
    event: text("event").notNull(),
    reason: text("reason"),
    actor: integer("actor"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("period_lock_events_company_period_idx").on(t.companyId, t.period),
    check("period_lock_events_period_chk", sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("period_lock_events_event_chk", sql`${t.event} in ('close', 'reopen') and (${t.event} = 'close' or length(btrim(${t.reason})) > 0)`),
  ],
);

/** DR-10: a filed VAT return (a month or a quarter), as the tenant states it. */
export const vatReturnFilingsTable = pgTable(
  "vat_return_filings",
  {
    id: serial("id").primaryKey(),
    ...tenant(),
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    kind: text("kind").notNull().default("original"),
    amendsZatcaReference: text("amends_zatca_reference"),
    filedOn: date("filed_on").notNull(),
    zatcaReference: text("zatca_reference").notNull(),
    notes: text("notes"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("vat_return_filings_one_original_unq").on(t.companyId, t.periodFrom, t.periodTo).where(sql`kind = 'original'`),
    uniqueIndex("vat_return_filings_reference_unq").on(t.companyId, t.zatcaReference),
    check("vat_return_filings_period_chk", sql`${t.periodFrom} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and ${t.periodTo} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and ${t.periodFrom} <= ${t.periodTo}`),
    check("vat_return_filings_kind_chk", sql`${t.kind} in ('original', 'amendment') and ((${t.kind} = 'original') = (${t.amendsZatcaReference} is null))`),
    check("vat_return_filings_reference_chk", sql`length(btrim(${t.zatcaReference})) >= 3`),
    check("vat_return_filings_after_period_chk", sql`${t.filedOn} >= (to_date(${t.periodTo} || '-01', 'YYYY-MM-DD') + interval '1 month')::date`),
  ],
);

/** DR-10: a filed Zakat or income-tax return, for one fiscal year (named by its end date). */
export const zakatIncomeTaxFilingsTable = pgTable(
  "zakat_income_tax_filings",
  {
    id: serial("id").primaryKey(),
    ...tenant(),
    tax: text("tax").notNull(),
    fiscalYearEnd: date("fiscal_year_end").notNull(),
    kind: text("kind").notNull().default("original"),
    amendsZatcaReference: text("amends_zatca_reference"),
    filedOn: date("filed_on").notNull(),
    zatcaReference: text("zatca_reference").notNull(),
    notes: text("notes"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("zakat_income_tax_filings_one_original_unq").on(t.companyId, t.tax, t.fiscalYearEnd).where(sql`kind = 'original'`),
    uniqueIndex("zakat_income_tax_filings_reference_unq").on(t.companyId, t.zatcaReference),
    check("zakat_income_tax_filings_tax_chk", sql`${t.tax} in ('zakat', 'income_tax')`),
    check("zakat_income_tax_filings_kind_chk", sql`${t.kind} in ('original', 'amendment') and ((${t.kind} = 'original') = (${t.amendsZatcaReference} is null))`),
    check("zakat_income_tax_filings_reference_chk", sql`length(btrim(${t.zatcaReference})) >= 3`),
    check("zakat_income_tax_filings_after_year_chk", sql`${t.filedOn} > ${t.fiscalYearEnd}`),
  ],
);

/**
 * DR-10 / IAS 10.17: the date a fiscal year's financial statements were
 * authorised for issue, and who gave that authorisation (as the tenant states
 * it: which corporate act fixes the date is the tenant's). DR-30: no month of
 * that year is reopened once this exists.
 */
export const statementAuthorisationsTable = pgTable(
  "statement_authorisations",
  {
    id: serial("id").primaryKey(),
    ...tenant(),
    fiscalYearStart: date("fiscal_year_start").notNull(),
    fiscalYearEnd: date("fiscal_year_end").notNull(),
    authorisedOn: date("authorised_on").notNull(),
    authorisedBy: text("authorised_by").notNull(),
    notes: text("notes"),
    recordedBy: integer("recorded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("statement_authorisations_year_unq").on(t.companyId, t.fiscalYearEnd),
    check("statement_authorisations_year_chk", sql`${t.fiscalYearStart} < ${t.fiscalYearEnd}`),
    check("statement_authorisations_after_year_chk", sql`${t.authorisedOn} > ${t.fiscalYearEnd}`),
    check("statement_authorisations_by_chk", sql`length(btrim(${t.authorisedBy})) >= 2`),
  ],
);
