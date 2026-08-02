/**
 * Onboarding service (M11.2) — the applicant-facing view of an organization's
 * verification state. Reachable by a user whose org is pending/needs_info/
 * rejected (it runs in the identity layer, before the verification gate), so the
 * web app can show the status page and (from M11.4/M11.5) the resubmit flow.
 *
 * Mirrors resolveTenant's active-org selection: honor the session's chosen org
 * if it is still an active membership, else default to the primary (first) one —
 * so the status shown matches the org the gate would evaluate.
 */
import { ForbiddenError } from "../lib/errors";
import { onboardingRepository } from "../repositories/onboarding.repository";

export const onboardingService = {
  async getStatus(userId: number, requestedOrgId?: string) {
    const memberships = await onboardingRepository.activeMembershipsWithVerification(userId);
    if (memberships.length === 0) {
      throw new ForbiddenError("You are not a member of any organization.");
    }
    const active =
      memberships.find((m) => m.organizationId === requestedOrgId) ?? memberships[0]!;
    return {
      organizationId: active.organizationId,
      name: active.name,
      status: active.verificationStatus,
      reason: active.verificationReason ?? null,
    };
  },
};
