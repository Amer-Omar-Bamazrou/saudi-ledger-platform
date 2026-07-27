import { pgTable, uuid, varchar, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

/**
 * Audit logs — records who did what, in which tenant. Every business mutation
 * (create/update/delete) is captured with before/after snapshots. System
 * actions have a null `user_id`.
 *
 * Added in Milestone 2 (additive). Population is wired up in a later milestone.
 */
export const auditLogsTable = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  userId: integer("user_id").references(() => usersTable.id), // nullable — system actions have no user
  action: varchar("action", { length: 50 }).notNull(), // create | update | delete
  entityType: varchar("entity_type", { length: 100 }).notNull(), // e.g. 'journal_entry', 'invoice'
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  ipAddress: varchar("ip_address", { length: 45 }), // holds IPv4 or IPv6
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;
