/**
 * 🔴 19B S6 (v4 §6.2, §9 D7; scope 19.14) — REPORT SCHEDULES, THEIR RUNS, AND THE IN-APP DELIVERY STORE.
 *
 *  - A SCHEDULE runs a saved report on a cadence (daily, weekly, monthly — by the BUSINESS day) as its OWNER, for a list
 *    of RECIPIENTS who are members of the same organization (each key carries the organization, G04's shape). It is
 *    ended, never deleted.
 *  - A RUN is the claim of one (schedule, period): the unique key is what makes "one run per period" true across two
 *    processes — the second insert conflicts and stops. Written by the job on the owner connection; the request's role
 *    only reads it.
 *  - A DELIVERY is ONE STORED COPY PER RECIPIENT, built at delivery from that recipient's grants at that moment: a field
 *    they may not see is never written into their copy. It carries a SHA-256 of its canonical content, checked at every
 *    open, and an expiry set at creation. At expiry the job CLEARS THE CONTENT and keeps a tombstone (id, report,
 *    recipient, created, expired, hash). 🔴 The request's role holds SELECT only: no route inserts, changes or deletes
 *    a copy, and the only reader is the one repository the open endpoint uses (a ratchet test lists the readers).
 */
import { pgTable, serial, uuid, varchar, integer, date, jsonb, timestamp, index, check, unique, foreignKey, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { organizationMembershipsTable } from "./memberships";
import { reportDefinitionsTable } from "./reportDefinitions";

export const REPORT_CADENCES = ["daily", "weekly", "monthly"] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

export const reportSchedulesTable = pgTable(
  "report_schedules",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
    companyId: uuid("company_id").notNull().references(() => companiesTable.id),
    definitionId: integer("definition_id").notNull(),
    ownerUserId: integer("owner_user_id").notNull(),
    cadence: varchar("cadence", { length: 16 }).$type<ReportCadence>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** Ended by its owner: it runs no more. The row stays — its runs and deliveries name it. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    unique("report_schedules_id_org_unq").on(t.id, t.organizationId),
    foreignKey({ name: "report_schedules_definition_fk", columns: [t.definitionId, t.organizationId], foreignColumns: [reportDefinitionsTable.id, reportDefinitionsTable.organizationId] }),
    foreignKey({ name: "report_schedules_owner_member_fk", columns: [t.ownerUserId, t.organizationId], foreignColumns: [organizationMembershipsTable.userId, organizationMembershipsTable.organizationId] }),
    check("report_schedules_cadence_chk", sql`${t.cadence} in ('daily', 'weekly', 'monthly')`),
    index("report_schedules_company_idx").on(t.companyId, t.ownerUserId),
  ],
);

export const reportScheduleRecipientsTable = pgTable(
  "report_schedule_recipients",
  {
    scheduleId: integer("schedule_id").notNull(),
    organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
    companyId: uuid("company_id").notNull().references(() => companiesTable.id),
    userId: integer("user_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "report_schedule_recipients_pk", columns: [t.scheduleId, t.userId] }),
    foreignKey({ name: "report_schedule_recipients_schedule_fk", columns: [t.scheduleId, t.organizationId], foreignColumns: [reportSchedulesTable.id, reportSchedulesTable.organizationId] }),
    foreignKey({ name: "report_schedule_recipients_member_fk", columns: [t.userId, t.organizationId], foreignColumns: [organizationMembershipsTable.userId, organizationMembershipsTable.organizationId] }),
  ],
);

export const REPORT_RUN_STATUSES = ["claimed", "delivered", "refused", "failed"] as const;
export type ReportRunStatus = (typeof REPORT_RUN_STATUSES)[number];

export const reportRunsTable = pgTable(
  "report_runs",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
    companyId: uuid("company_id").notNull().references(() => companiesTable.id),
    scheduleId: integer("schedule_id").notNull(),
    /** The period this run is FOR: a business day, the week's first day, or a month (`2026-11-26`, `W2026-11-22`, `2026-11`). */
    periodKey: varchar("period_key", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).$type<ReportRunStatus>().notNull().default("claimed"),
    /** Why a run was refused or failed — a code, never a value. */
    outcomeCode: varchar("outcome_code", { length: 64 }),
    windowFrom: date("window_from"),
    windowTo: date("window_to"),
    deliveredCount: integer("delivered_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // 🔴 ONE RUN PER PERIOD: the claim. Two processes cannot both insert it.
    unique("report_runs_schedule_period_unq").on(t.scheduleId, t.periodKey),
    unique("report_runs_id_org_unq").on(t.id, t.organizationId),
    foreignKey({ name: "report_runs_schedule_fk", columns: [t.scheduleId, t.organizationId], foreignColumns: [reportSchedulesTable.id, reportSchedulesTable.organizationId] }),
    check("report_runs_status_chk", sql`${t.status} in ('claimed', 'delivered', 'refused', 'failed')`),
  ],
);

export const reportDeliveriesTable = pgTable(
  "report_deliveries",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
    companyId: uuid("company_id").notNull().references(() => companiesTable.id),
    runId: integer("run_id").notNull(),
    definitionId: integer("definition_id").notNull(),
    recipientUserId: integer("recipient_user_id").notNull(),
    /** The tombstone's own facts — what the copy WAS, kept after its content is gone. */
    reportName: varchar("report_name", { length: 120 }).notNull(),
    dataset: varchar("dataset", { length: 64 }).notNull(),
    windowFrom: date("window_from"),
    windowTo: date("window_to"),
    rowCount: integer("row_count").notNull(),
    /** The copy: the recipient's own columns, rows and withheld list at delivery. NULL once expired. */
    content: jsonb("content").$type<unknown>(),
    /** SHA-256 (hex) of the canonical content, checked at every open. Kept in the tombstone. */
    contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set by the expiry job when it clears the content. */
    expiredAt: timestamp("expired_at", { withTimezone: true }),
  },
  (t) => [
    unique("report_deliveries_run_recipient_unq").on(t.runId, t.recipientUserId),
    foreignKey({ name: "report_deliveries_run_fk", columns: [t.runId, t.organizationId], foreignColumns: [reportRunsTable.id, reportRunsTable.organizationId] }),
    foreignKey({ name: "report_deliveries_definition_fk", columns: [t.definitionId, t.organizationId], foreignColumns: [reportDefinitionsTable.id, reportDefinitionsTable.organizationId] }),
    foreignKey({ name: "report_deliveries_recipient_member_fk", columns: [t.recipientUserId, t.organizationId], foreignColumns: [organizationMembershipsTable.userId, organizationMembershipsTable.organizationId] }),
    // 🔴 content and expiry move together: a copy either has its content, or it is an expired tombstone
    check("report_deliveries_tombstone_chk", sql`(${t.content} is null) = (${t.expiredAt} is not null)`),
    check("report_deliveries_expiry_chk", sql`${t.expiresAt} > ${t.createdAt}`),
    index("report_deliveries_recipient_idx").on(t.companyId, t.recipientUserId, t.createdAt),
    index("report_deliveries_expiry_idx").on(t.expiresAt),
  ],
);

export type ReportScheduleRow = typeof reportSchedulesTable.$inferSelect;
export type ReportRunRow = typeof reportRunsTable.$inferSelect;
export type ReportDeliveryRow = typeof reportDeliveriesTable.$inferSelect;
