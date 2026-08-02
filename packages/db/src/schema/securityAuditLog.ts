import { pgTable, uuid, varchar, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

/**
 * Security-audit log (Phase 1 / M11.1) — the actor-centric trail of identity &
 * security events, kept DELIBERATELY SEPARATE from the tenant-scoped business
 * `audit_logs`.
 *
 * Why a separate table (the M7 boundary made concrete):
 *   - `audit_logs.organization_id` is NOT NULL, RLS-scoped, and written INSIDE
 *     the request's tenant transaction (as the non-owner app role). It records
 *     *business* mutations that belong to exactly one tenant.
 *   - Identity/security events are different: many have NO active org (a user is
 *     created, a password is reset), they are ACTOR-centric rather than
 *     tenant-centric, and they occur in the identity/infrastructure layer BEFORE
 *     `resolveTenant` runs — on the base/owner connection, outside any tenant tx.
 *
 * So this table:
 *   - has a NULLABLE `organization_id` (global events carry none; membership /
 *     verification events carry the target org),
 *   - is written & read ONLY on the base/owner connection by the identity layer
 *     (`securityAuditService`); the RLS app role is granted NOTHING on it, which
 *     keeps it entirely off the tenant-scoped path (proven by a DB boundary test),
 *   - is append-only by construction — the service exposes only insert + read;
 *     there is no update/delete path.
 *
 * `action` is a free dotted string (e.g. `user.created`, `membership.role_changed`,
 * and — from M11.2+ — `verification.approved`). `metadata` carries event-specific
 * before/after detail (never secrets: no password material, no tokens).
 */
export const securityAuditLogsTable = pgTable(
  "security_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Who performed the action. NULLABLE for anonymous/system events (e.g. a
    // future public invite-accept that runs before the account exists).
    actorUserId: integer("actor_user_id").references(() => usersTable.id),
    // Denormalized actor email snapshot — durable if the user is later removed,
    // and meaningful even when the actor predates their account (public flows).
    actorEmail: varchar("actor_email", { length: 320 }),
    // Target organization — NULLABLE: global identity events (user created /
    // password reset) have none; membership & verification events set it.
    organizationId: uuid("organization_id").references(() => organizationsTable.id),
    // The user the action concerns (e.g. the member whose role changed), if any.
    targetUserId: integer("target_user_id").references(() => usersTable.id),
    action: varchar("action", { length: 100 }).notNull(),
    metadata: jsonb("metadata"),
    ipAddress: varchar("ip_address", { length: 45 }), // holds IPv4 or IPv6
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("security_audit_logs_org_idx").on(t.organizationId),
    index("security_audit_logs_actor_idx").on(t.actorUserId),
    index("security_audit_logs_created_idx").on(t.createdAt),
  ],
);

export const insertSecurityAuditLogSchema = createInsertSchema(securityAuditLogsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertSecurityAuditLog = typeof securityAuditLogsTable.$inferInsert;
export type SecurityAuditLog = typeof securityAuditLogsTable.$inferSelect;
