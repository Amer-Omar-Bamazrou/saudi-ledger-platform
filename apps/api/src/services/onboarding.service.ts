/**
 * Onboarding service (M11.2/M11.4) — the applicant-facing view of an
 * organization's verification state and its documents. Reachable by a user whose
 * org is pending/needs_info/rejected (it runs in the identity layer, before the
 * verification gate), so the web app can show the status page and the
 * upload/resubmit flow.
 *
 * Active-org selection mirrors resolveTenant: honor the session's chosen org if
 * it is still an active membership, else default to the primary (first) one — so
 * the status/documents shown match the org the gate would evaluate.
 */
import { ConflictError, ForbiddenError } from "../lib/errors";
import { onboardingRepository } from "../repositories/onboarding.repository";
import { securityAuditService } from "./securityAudit.service";

type ActiveMembership = Awaited<
  ReturnType<typeof onboardingRepository.activeMembershipsWithVerification>
>[number];

async function activeMembership(userId: number, requestedOrgId?: string): Promise<ActiveMembership> {
  const memberships = await onboardingRepository.activeMembershipsWithVerification(userId);
  if (memberships.length === 0) {
    throw new ForbiddenError("You are not a member of any organization.");
  }
  return memberships.find((m) => m.organizationId === requestedOrgId) ?? memberships[0]!;
}

export const onboardingService = {
  async getStatus(userId: number, requestedOrgId?: string) {
    const active = await activeMembership(userId, requestedOrgId);
    return {
      organizationId: active.organizationId,
      name: active.name,
      status: active.verificationStatus,
      reason: active.verificationReason ?? null,
    };
  },

  /**
   * Resolve the caller's active organization id, asserting membership. Used by
   * the document endpoints so an applicant only ever acts on their own org.
   */
  async requireActiveOrgId(userId: number, requestedOrgId?: string): Promise<string> {
    return (await activeMembership(userId, requestedOrgId)).organizationId;
  },

  /**
   * Applicant resubmits after supplying the requested information:
   * `needs_info → pending_review` (audited, and recorded in the review history).
   * Only valid from `needs_info` — `rejected` is terminal for the applicant (only
   * an operator can reopen it), and pending/approved have nothing to resubmit.
   */
  async resubmit(
    userId: number,
    requestedOrgId?: string,
    ctx: { actorEmail?: string | null; ipAddress?: string | null } = {},
  ) {
    const active = await activeMembership(userId, requestedOrgId);
    if (active.verificationStatus !== "needs_info") {
      throw new ConflictError(
        `Cannot resubmit an application in '${active.verificationStatus}' state.`,
      );
    }

    const [updated] = await onboardingRepository.resubmit(active.organizationId);
    if (!updated) {
      // Lost a race with an operator decision — re-read and report the truth.
      throw new ConflictError("This application is no longer awaiting more information.");
    }
    await onboardingRepository.insertResubmitReview(active.organizationId);
    await securityAuditService.record({
      action: "verification.resubmitted",
      actorUserId: userId,
      actorEmail: ctx.actorEmail,
      organizationId: active.organizationId,
      metadata: { fromStatus: "needs_info", toStatus: "pending_review" },
      ipAddress: ctx.ipAddress,
    });

    return { organizationId: updated.organizationId, status: updated.status, reason: null };
  },
};
