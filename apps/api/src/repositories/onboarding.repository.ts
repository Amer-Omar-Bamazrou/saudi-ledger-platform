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
import { db, organizationMembershipsTable, organizationsTable } from "@workspace/db";
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
};
