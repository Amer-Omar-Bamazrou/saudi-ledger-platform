/**
 * 🔴 19B S4 — D6, THE REFUSAL EVENT (v4 §8): who tried to take what, and was refused.
 *
 * Recorded for a refused export, schedule (creating one, or running one), delivery (a recipient skipped), and a refused
 * field write. NOT for a refused run, nor for a field withheld from an ordinary read (D6).
 *
 * 🔴 It cannot hold a value. There is no column for a field's value, a filter's operand or a request body — only the
 * NAMES of the fields and their classes — so "never a field value" is a property of the table, not a promise of its
 * writers. A test plants a known value and asserts it appears nowhere in the row.
 *
 * Written on its OWN connection (the owner's), outside the refused request's transaction, which rolls back. Owner-only:
 * the application's role holds nothing on it (migration 0171), like `security_audit_logs`. Append-only for every role,
 * the owner included (UPDATE, DELETE and TRUNCATE are refused; replica mode is the only bypass, as for the audit
 * tables). Its time is set by the database, never by the writer.
 */
import { pgTable, bigserial, uuid, varchar, integer, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const REFUSAL_EVENT_ACTIONS = ["export", "schedule", "schedule_run", "deliver", "field_write"] as const;
export type RefusalEventAction = (typeof REFUSAL_EVENT_ACTIONS)[number];

export const permissionRefusalEventsTable = pgTable(
  "permission_refusal_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    /** The request that was refused (19.8), from the request's own context. */
    requestId: varchar("request_id", { length: 64 }),
    /** For a scheduled run, the schedule's owner. */
    actorUserId: integer("actor_user_id").references(() => usersTable.id),
    organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
    companyId: uuid("company_id").references(() => companiesTable.id),
    action: varchar("action", { length: 32 }).$type<RefusalEventAction>().notNull(),
    /** The dataset, the report, or the record's resource — by name. */
    resource: varchar("resource", { length: 128 }).notNull(),
    refusalCode: varchar("refusal_code", { length: 64 }).notNull(),
    /** Names only — never a value. */
    fieldNames: text("field_names").array().notNull().default(sql`'{}'::text[]`),
    fieldClasses: text("field_classes").array().notNull().default(sql`'{}'::text[]`),
    recipientUserId: integer("recipient_user_id").references(() => usersTable.id),
  },
  (t) => [
    check("permission_refusal_events_action_chk", sql`${t.action} in ('export', 'schedule', 'schedule_run', 'deliver', 'field_write')`),
    index("permission_refusal_events_org_idx").on(t.organizationId, t.occurredAt),
  ],
);

export type PermissionRefusalEvent = typeof permissionRefusalEventsTable.$inferSelect;
