import { pgTable, uuid, integer, boolean, varchar, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

/**
 * 🔴 Phase 19A (19.7, owner approval 2026-11-17) — ONE set of security settings per organization. A missing row IS the
 * platform default, which is also the WEAKEST value the platform allows (two-step verification for admins only, the
 * 12-hour absolute session lifetime, the 8-hour idle limit) — so an organization can only ever make itself stricter
 * than the platform, never looser, and the bounds are the database's (CHECKs below).
 *
 * Identity layer: read at sign-in and by the session seam, before any tenant is resolved — so, like `session_records`,
 * it is OWNER-ONLY with no RLS (0167 revokes explicitly), and only an admin of THIS organization reaches it through the
 * API. A WEAKENING change in an organization with two or more usable admins needs a second admin's approval: 0167's
 * trigger refuses the weakening itself unless a matching request was approved in the same transaction (the DR-23
 * dual-control pattern, 0151). An internal control of the platform.
 */
export const orgSecuritySettingsTable = pgTable(
  "org_security_settings",
  {
    organizationId: uuid("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** Two-step verification for EVERY member (admins always need it). */
    mfaRequiredForAll: boolean("mfa_required_for_all").notNull().default(false),
    /** Hours from sign-in after which a session ends, whatever the activity (platform maximum 12). */
    sessionLifetimeHours: integer("session_lifetime_hours").notNull().default(12),
    /** Minutes without a request after which a session ends (platform maximum 480). */
    idleTimeoutMinutes: integer("idle_timeout_minutes").notNull().default(480),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  },
  (t) => [
    check("org_security_settings_lifetime_chk", sql`${t.sessionLifetimeHours} between 1 and 12`),
    check("org_security_settings_idle_chk", sql`${t.idleTimeoutMinutes} between 15 and 480`),
  ],
);

/** A change to the settings that WEAKENS them, waiting for (or decided by) a second admin. One pending per organization. */
export const orgSecuritySettingChangesTable = pgTable(
  "org_security_setting_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
    mfaBefore: boolean("mfa_before").notNull(),
    mfaAfter: boolean("mfa_after").notNull(),
    lifetimeBefore: integer("lifetime_before").notNull(),
    lifetimeAfter: integer("lifetime_after").notNull(),
    idleBefore: integer("idle_before").notNull(),
    idleAfter: integer("idle_after").notNull(),
    status: varchar("status", { length: 10 }).notNull().default("pending"),
    requestedBy: integer("requested_by").notNull().references(() => usersTable.id),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    decidedBy: integer("decided_by").references(() => usersTable.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("org_security_setting_changes_pending_unq").on(t.organizationId).where(sql`${t.status} = 'pending'`),
    check("org_security_setting_changes_status_chk", sql`${t.status} in ('pending', 'approved', 'rejected')`),
    check("org_security_setting_changes_decision_chk", sql`(${t.status} = 'pending') = (${t.decidedBy} is null and ${t.decidedAt} is null)`),
    check("org_security_setting_changes_after_chk", sql`${t.lifetimeAfter} between 1 and 12 and ${t.idleAfter} between 15 and 480`),
  ],
);
