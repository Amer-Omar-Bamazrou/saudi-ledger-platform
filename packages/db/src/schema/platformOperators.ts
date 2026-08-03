import { pgTable, uuid, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Platform operators (M11.3) — the small set of users who may REVIEW
 * organization verification applications (approve / reject / request-info /
 * reopen). This is a cross-tenant, security-sensitive privilege, so it is scoped
 * tightly and deliberately:
 *
 *   - Membership in this table is granted ONLY out-of-band, via the seed/CLI
 *     (`SEED_OPERATOR_EMAIL`). NO HTTP route ever grants operator status — the
 *     privilege is never reachable from the application's attack surface.
 *   - An operator is NOT a member of any organization (`organization_memberships`),
 *     so `resolveTenant` 403s them from every business route: operator status
 *     grants EXACTLY ZERO access to tenant financial data. Operators get no
 *     BYPASSRLS, and the only surface keyed off this table (`/operator`) returns
 *     verification metadata only — never a tenant's invoices/GL/reports.
 *
 * Owner-only table (identity/infrastructure layer, base connection). No RLS and
 * no app-role grants — the RLS app role cannot touch it (a DB boundary test
 * proves this), keeping it off the tenant-scoped path.
 */
export const platformOperatorsTable = pgTable("platform_operators", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id),
  grantedBy: integer("granted_by").references(() => usersTable.id), // null for seed/CLI grants
  grantedAt: timestamp("granted_at").defaultNow().notNull(),
});

export const insertPlatformOperatorSchema = createInsertSchema(platformOperatorsTable).omit({
  id: true,
  grantedAt: true,
});

export type InsertPlatformOperator = typeof platformOperatorsTable.$inferInsert;
export type PlatformOperator = typeof platformOperatorsTable.$inferSelect;
