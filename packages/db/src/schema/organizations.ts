import { pgTable, uuid, varchar, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Verification lifecycle (M11.2) — the review gate a self-service signup passes
 * before it may use the platform.
 *
 *   pending_review → approved            (operator approves; full access)
 *   pending_review → needs_info(reason)  (operator returns for more info; resubmittable)
 *   pending_review → rejected(reason)    (operator rejects; terminal-by-default)
 *
 * ONLY `approved` grants access to business routes — the gate lives in
 * `resolveTenant` (see apps/api/src/lib/tenant.ts). `pending_review` is the DB
 * default for new rows; existing organizations were grandfathered to `approved`
 * by migration 0011, and the seed sets the default org `approved`.
 */
export const VERIFICATION_STATUSES = [
  "pending_review",
  "needs_info",
  "approved",
  "rejected",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * Organizations — the tenant / customer account. This is the hard isolation
 * boundary: `organization_id` gates every business query and (later) every RLS
 * policy. Two organizations can never see each other's data.
 *
 * Added in Milestone 2 (additive). Not yet enforced on business tables.
 */
export const organizationsTable = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(), // URL-safe identifier
  plan: varchar("plan", { length: 50 }).notNull().default("free"), // billing tier placeholder
  status: varchar("status", { length: 50 }).notNull().default("active"),
  // Verification gate (M11.2). New rows default to `pending_review`; only
  // `approved` orgs may use business routes (enforced in resolveTenant).
  verificationStatus: varchar("verification_status", { length: 30 })
    .notNull()
    .default("pending_review"),
  verificationReason: text("verification_reason"), // reason for needs_info / rejected
  verificationReviewedBy: integer("verification_reviewed_by").references(() => usersTable.id), // operator
  verificationReviewedAt: timestamp("verification_reviewed_at"),
  verificationSubmittedAt: timestamp("verification_submitted_at"), // set at signup (M11.5)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertOrganizationSchema = createInsertSchema(organizationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizationsTable.$inferSelect;
