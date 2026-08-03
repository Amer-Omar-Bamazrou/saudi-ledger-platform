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
import { ForbiddenError } from "../lib/errors";
import { onboardingRepository } from "../repositories/onboarding.repository";

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
};
