/**
 * Members service — administer the memberships of an organization (M10.6):
 * provision a bookkeeper, change a member's role/status. Active-org scoped.
 *
 * LAYER: runs in the identity/infrastructure layer (called from the /orgs router
 * BEFORE resolveTenant, on the base/owner connection). `organization_memberships`
 * is global-reference data, so there is NO RLS backstop — authorization is
 * therefore EXPLICIT here: every operation verifies the actor is an active
 * `admin` of the *specific* org being modified. An admin of org A cannot touch
 * org B.
 *
 * AUDIT: membership/role changes are identity/security events. Per the M7
 * boundary they must NOT be written to the tenant-scoped business `audit_logs`;
 * they belong in a dedicated security-audit log that does not exist yet.
 * TODO(security-audit): capture assign/update here once that log is built.
 *
 * SCOPE (M10.6): assign/change a role in an org the actor administers — enough to
 * provision a bookkeeper and make the approval feature usable end to end.
 * Cross-org management and invites are Phase 1 onboarding work.
 */
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors";
import { membersRepository } from "../repositories/members.repository";

export const VALID_MEMBERSHIP_ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
export type MembershipRole = (typeof VALID_MEMBERSHIP_ROLES)[number];

/** Explicitly require the actor to be an active admin of THIS org (no ambient context). */
async function assertOrgAdmin(actorUserId: number, orgId: string): Promise<void> {
  const role = await membersRepository.activeRole(actorUserId, orgId);
  if (role !== "admin") {
    throw new ForbiddenError("You must be an admin of this organization to manage its members.");
  }
}

export const membersService = {
  async list(actorUserId: number, orgId: string) {
    await assertOrgAdmin(actorUserId, orgId);
    return { members: await membersRepository.listMembers(orgId) };
  },

  /** Assign (or re-activate) a role for an existing user in this org. */
  async assign(actorUserId: number, orgId: string, userId: unknown, role: unknown) {
    await assertOrgAdmin(actorUserId, orgId);
    if (typeof userId !== "number" || !VALID_MEMBERSHIP_ROLES.includes(role as MembershipRole)) {
      throw new BadRequestError(
        `userId (number) and role (${VALID_MEMBERSHIP_ROLES.join(" | ")}) are required.`,
      );
    }
    if (!(await membersRepository.userExists(userId))) throw new NotFoundError("User not found.");

    const [membership] = await membersRepository.upsert(userId, orgId, role as MembershipRole);
    // TODO(security-audit): record this membership assignment once the log exists.
    return { userId, organizationId: orgId, role: membership.role, status: membership.status };
  },

  /** Change a member's role/status; refuse to orphan the last active admin. */
  async update(
    actorUserId: number,
    orgId: string,
    targetUserId: number,
    changes: { role?: unknown; status?: unknown },
  ) {
    await assertOrgAdmin(actorUserId, orgId);

    const { role, status } = changes;
    if (role !== undefined && !VALID_MEMBERSHIP_ROLES.includes(role as MembershipRole)) {
      throw new BadRequestError(`Invalid role. Must be ${VALID_MEMBERSHIP_ROLES.join(" | ")}.`);
    }
    if (status !== undefined && !["active", "inactive"].includes(status as string)) {
      throw new BadRequestError("Invalid status. Must be active or inactive.");
    }

    const [existing] = await membersRepository.findMembership(targetUserId, orgId);
    if (!existing) throw new NotFoundError("Membership not found.");

    // Refuse to remove the last active admin (via demotion or deactivation).
    const isActiveAdmin = existing.role === "admin" && existing.status === "active";
    const willLoseAdmin = (role !== undefined && role !== "admin") || status === "inactive";
    if (isActiveAdmin && willLoseAdmin && (await membersRepository.activeAdminCount(orgId)) <= 1) {
      throw new ConflictError("Cannot remove the last admin of the organization.");
    }

    const updates: { role?: MembershipRole; status?: string } = {};
    if (role !== undefined) updates.role = role as MembershipRole;
    if (status !== undefined) updates.status = status as string;

    const [membership] = await membersRepository.update(targetUserId, orgId, updates);
    // TODO(security-audit): record this membership change once the log exists.
    return { userId: targetUserId, organizationId: orgId, role: membership.role, status: membership.status };
  },
};
