/**
 * 🔴 19B S6 (v4 §4, §6.2; scope 19.9–19.13) — A SAVED REPORT: a definition over one vetted dataset — which columns, in
 * which order, for which period, with which of the dataset's declared filters and sort. Never SQL, never a join: a
 * definition can only name what its dataset offers, and the server checks that at every save.
 *
 *  - OWNED by a member of the organization (the foreign key is to the MEMBERSHIP, G04's shape: the organization is
 *    part of the key). Only the owner changes, shares or archives it.
 *  - COMPANY-SCOPED: a definition belongs to the company it was saved in (N1). RLS carries both arms.
 *  - SHARED WITH ROLES of the same organization (`shared_roles`). Sharing shows the definition; it grants nothing —
 *    every run asks `decide()` for the runner's own role, at every request.
 *  - THE PERIOD is a name (`this_month`, `last_month`, …) resolved at each run by `@workspace/shared`'s one resolver,
 *    or a fixed window. A relative period is never frozen into dates.
 *  - ARCHIVED, never deleted: schedules and stored deliveries name a definition, and their rows keep it.
 */
import { pgTable, serial, uuid, varchar, integer, text, date, jsonb, timestamp, index, check, unique, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { organizationMembershipsTable } from "./memberships";

export const reportDefinitionsTable = pgTable(
  "report_definitions",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
    companyId: uuid("company_id").notNull().references(() => companiesTable.id),
    ownerUserId: integer("owner_user_id").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    /** A dataset's name (lib/reports/datasets.ts). Datasets are code; an unknown name is refused at save and at run. */
    dataset: varchar("dataset", { length: 64 }).notNull(),
    /** Column keys, in the order shown. Empty = every column of the dataset. */
    columns: text("columns").array().notNull().default(sql`'{}'::text[]`),
    periodKind: varchar("period_kind", { length: 32 }).notNull(),
    dateFrom: date("date_from"),
    dateTo: date("date_to"),
    /** The dataset's other declared filters (query parameter → value), e.g. `{ "account_id": "12" }`. */
    filters: jsonb("filters").$type<Record<string, string>>().notNull().default({}),
    /** A column key; a leading '-' sorts descending. NULL = the dataset's own order. */
    sort: varchar("sort", { length: 64 }),
    sharedRoles: text("shared_roles").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("report_definitions_id_org_unq").on(t.id, t.organizationId),
    foreignKey({ name: "report_definitions_owner_member_fk", columns: [t.ownerUserId, t.organizationId], foreignColumns: [organizationMembershipsTable.userId, organizationMembershipsTable.organizationId] }),
    check("report_definitions_period_chk", sql`${t.periodKind} in ('fixed', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year')`),
    check("report_definitions_fixed_window_chk", sql`(${t.periodKind} = 'fixed') = (${t.dateFrom} is not null and ${t.dateTo} is not null) and (${t.dateFrom} is null) = (${t.dateTo} is null) and (${t.dateFrom} is null or ${t.dateFrom} <= ${t.dateTo})`),
    check("report_definitions_shared_roles_chk", sql`${t.sharedRoles} <@ array['admin', 'accountant', 'bookkeeper', 'viewer']::text[]`),
    index("report_definitions_company_idx").on(t.companyId, t.ownerUserId),
  ],
);

export type ReportDefinitionRow = typeof reportDefinitionsTable.$inferSelect;
