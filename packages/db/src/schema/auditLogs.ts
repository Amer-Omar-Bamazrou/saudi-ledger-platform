import { pgTable, uuid, varchar, integer, jsonb, timestamp, index, bigint, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

/**
 * Audit logs — records who did what, in which tenant. Every business mutation
 * (create/update/delete) is captured with before/after snapshots. System
 * actions have a null `user_id`.
 *
 * 🔴 T1b (Phase 18, G24/G25; migration 0132): append-only for EVERY role, the
 * owner included — UPDATE, DELETE and TRUNCATE are refused by trigger, and
 * `session_replication_role = replica` is the only bypass. And the user is the
 * CONNECTION's declared actor (`TenantScope.actorUserId` →
 * `app.current_user_id`): `user_id` defaults to it, and a row naming anyone
 * else is refused, so the writer never chooses who acted.
 *
 * 🔴 Phase 18 audit A6 (G25, "sequence or chain"; migration 0159): nor WHEN, nor in what ORDER. A BEFORE INSERT
 * trigger sets `created_at` to the transaction's time and `seq` from the database's own sequence, whatever the writer
 * supplied; readers order by `seq`. `seq` is NULL only on rows written before 0159 — and on history a test plants
 * in replica mode, the one bypass 0132 names.
 *
 * 🔴 19B 19.18 (migration 0177): `company_id` and `request_id`, written by the report audit entries
 * (`reportAudit.service.ts`) and NULL on every other row. `(organization, request id, action, entity)` is UNIQUE where
 * a request id is given: the same request cannot record the same act twice. `company_id` is a plain value, not a
 * foreign key — an audit row is history, and nothing it names may be made to depend on it.
 *
 * Added in Milestone 2 (additive). Population is wired up in a later milestone.
 */
export const auditLogsTable = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  // nullable — system actions have no user; never written by the app (T1b)
  userId: integer("user_id")
    .default(sql`(nullif(current_setting('app.current_user_id', true), ''))::integer`)
    .references(() => usersTable.id),
  action: varchar("action", { length: 50 }).notNull(), // create | update | delete
  entityType: varchar("entity_type", { length: 100 }).notNull(), // e.g. 'journal_entry', 'invoice'
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  ipAddress: varchar("ip_address", { length: 45 }), // holds IPv4 or IPv6
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // Set by the database (0159); never written by the app.
    seq: bigint("seq", { mode: "number" }),
    /** 19.18 — the company of the request that wrote the entry; NULL on entries written before, or by other writers. */
    companyId: uuid("company_id"),
    /** 19.18 — the id of the request that wrote the entry (`X-Request-Id`), or `scheduled-run:<id>` for the job. */
    requestId: varchar("request_id", { length: 64 }),
  },
  (t) => [
    index("audit_logs_org_idx").on(t.organizationId),
    uniqueIndex("audit_logs_seq_unq").on(t.seq),
    uniqueIndex("audit_logs_request_event_unq").on(t.organizationId, t.requestId, t.action, t.entityType, t.entityId).where(sql`request_id is not null`),
  ],
);

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({
  id: true,
  createdAt: true,
  seq: true,
});

export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;
