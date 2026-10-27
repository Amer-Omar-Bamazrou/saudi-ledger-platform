import { pgTable, uuid, varchar, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
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
  },
  (t) => [index("audit_logs_org_idx").on(t.organizationId)],
);

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;
