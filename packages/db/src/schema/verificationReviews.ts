import { pgTable, uuid, varchar, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

/**
 * Verification review history (M11.3) — the append-only audit of every operator
 * decision on an organization's verification application (each status
 * transition, who made it, and why). Distinct from the security-audit log: this
 * is the domain-level review trail shown on the operator surface (and, later, the
 * applicant's status page), whereas `security_audit_logs` is the cross-cutting
 * actor-centric security trail.
 *
 * Owner-only table (identity/infrastructure layer, base connection): written by
 * the operator surface and read by the operator/onboarding surfaces, all before
 * `resolveTenant`. No RLS, no app-role grants.
 */
export const verificationReviewsTable = pgTable(
  "verification_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    operatorUserId: integer("operator_user_id").references(() => usersTable.id),
    fromStatus: varchar("from_status", { length: 30 }),
    toStatus: varchar("to_status", { length: 30 }).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("verification_reviews_org_idx").on(t.organizationId)],
);

export const insertVerificationReviewSchema = createInsertSchema(verificationReviewsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertVerificationReview = typeof verificationReviewsTable.$inferInsert;
export type VerificationReview = typeof verificationReviewsTable.$inferSelect;
