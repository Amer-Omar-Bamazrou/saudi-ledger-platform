/**
 * Onboarding repository (M11.2) — reads an applicant's organization verification
 * state.
 *
 * IMPORTANT: like the members/orgs repositories, this is identity/infrastructure
 * data read on the BASE (owner) connection, BEFORE `resolveTenant`. The
 * `/onboarding/*` surface must remain reachable by a user whose org is NOT yet
 * approved (that is the whole point — it hosts the status/resubmit flow), so it
 * runs outside the verification gate and outside tenant scoping. Callers
 * authorize by membership.
 */
// 🔴 The OWNER connection, named deliberately rather than inherited.
// Onboarding runs across the identity tables before a tenant context exists.
import {
  ownerDb as db,
  organizationMembershipsTable,
  organizationsTable,
  verificationReviewsTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

export const onboardingRepository = {
  /** The user's active memberships joined to each org's verification state. */
  activeMembershipsWithVerification(userId: number) {
    return db
      .select({
        organizationId: organizationsTable.id,
        name: organizationsTable.name,
        verificationStatus: organizationsTable.verificationStatus,
        verificationReason: organizationsTable.verificationReason,
      })
      .from(organizationMembershipsTable)
      .innerJoin(
        organizationsTable,
        eq(organizationsTable.id, organizationMembershipsTable.organizationId),
      )
      .where(
        and(
          eq(organizationMembershipsTable.userId, userId),
          eq(organizationMembershipsTable.status, "active"),
        ),
      )
      .orderBy(asc(organizationMembershipsTable.createdAt));
  },

  /**
   * Applicant resubmission: needs_info → pending_review, clearing the reason and
   * re-stamping the submission time. Guarded IN THE UPDATE (`status='needs_info'`)
   * so a concurrent operator decision can't be clobbered — zero rows back means
   * the org was no longer in needs_info.
   */
  resubmit(orgId: string) {
    return db
      .update(organizationsTable)
      .set({
        verificationStatus: "pending_review",
        verificationReason: null,
        verificationSubmittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(organizationsTable.id, orgId),
          eq(organizationsTable.verificationStatus, "needs_info"),
        ),
      )
      .returning({
        organizationId: organizationsTable.id,
        status: organizationsTable.verificationStatus,
      });
  },

  /** Record the resubmission in the shared review history (no operator actor). */
  insertResubmitReview(orgId: string) {
    return db.insert(verificationReviewsTable).values({
      organizationId: orgId,
      operatorUserId: null,
      fromStatus: "needs_info",
      toStatus: "pending_review",
      reason: null,
    });
  },
};
