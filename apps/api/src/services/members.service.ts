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
 * boundary they are NOT written to the tenant-scoped business `audit_logs`; they
 * go to the dedicated `security_audit_logs` via `securityAuditService` (M11.1).
 * Recording is best-effort (see that service) so it never turns an already-
 * committed membership change into a reported error.
 *
 * SCOPE (M10.6): assign/change a role in an org the actor administers — enough to
 * provision a bookkeeper and make the approval feature usable end to end.
 * Cross-org management and invites are Phase 1 onboarding work.
 */
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors";
import { membersRepository } from "../repositories/members.repository";
import { assertAccountConfinedTo } from "../lib/accountScope";
import { securityAuditService } from "./securityAudit.service";

/** Actor context for the security-audit trail, threaded from the identity route. */
export interface MemberActionContext {
  actorEmail?: string | null;
  ipAddress?: string | null;
}

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
  async assign(
    actorUserId: number,
    orgId: string,
    userId: unknown,
    role: unknown,
    ctx: MemberActionContext = {},
  ) {
    await assertOrgAdmin(actorUserId, orgId);
    if (typeof userId !== "number" || !VALID_MEMBERSHIP_ROLES.includes(role as MembershipRole)) {
      throw new BadRequestError(
        `userId (number) and role (${VALID_MEMBERSHIP_ROLES.join(" | ")}) are required.`,
      );
    }
    if (!(await membersRepository.userExists(userId))) throw new NotFoundError("User not found.");

    // 🔴 F1 — the act that made the M11.5.1 scope forgeable.
    // Creating a membership here is the ONLY way one admin can make a stranger's
    // account "theirs", and `userAdminService` trusted exactly that fact to
    // decide who may have their password reset. So the boundary belongs here as
    // well as there: an account that already belongs to an organization this
    // actor does not administer is not one they may quietly graft into their
    // own. The consented path for such a person is an INVITATION (M11.7) —
    // token to their address, accepted by them.
    // Concealed (404, identical to a nonexistent id): the actor supplied a raw
    // user id, and a distinct refusal would confirm that the id belongs to
    // someone — the cross-tenant enumeration M11.5.1 removed.
    await assertAccountConfinedTo(userId, await membersRepository.administeredOrgIds(actorUserId), "conceal");

    const [membership] = await membersRepository.upsert(userId, orgId, role as MembershipRole);
    await securityAuditService.record({
      action: "membership.assigned",
      actorUserId,
      actorEmail: ctx.actorEmail,
      organizationId: orgId,
      targetUserId: userId,
      metadata: { role: membership.role, status: membership.status },
      ipAddress: ctx.ipAddress,
    });
    return { userId, organizationId: orgId, role: membership.role, status: membership.status };
  },

  /** Change a member's role/status; refuse to orphan the last active admin. */
  async update(
    actorUserId: number,
    orgId: string,
    targetUserId: number,
    changes: { role?: unknown; status?: unknown },
    ctx: MemberActionContext = {},
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
    if (!membership) throw new NotFoundError("Membership not found.");

    // A role change and a (de)activation are distinct security events; pick the
    // salient action and carry full before/after detail in metadata.
    const roleChanged = updates.role !== undefined && updates.role !== existing.role;
    await securityAuditService.record({
      action: roleChanged ? "membership.role_changed" : "membership.status_changed",
      actorUserId,
      actorEmail: ctx.actorEmail,
      organizationId: orgId,
      targetUserId,
      metadata: {
        before: { role: existing.role, status: existing.status },
        after: { role: membership.role, status: membership.status },
      },
      ipAddress: ctx.ipAddress,
    });
    return { userId: targetUserId, organizationId: orgId, role: membership.role, status: membership.status };
  },

  /**
   * Remove a member from the organization (M11.7) — deactivates the membership
   * rather than deleting it, so the audit/history of who had access survives.
   * Reuses `update`'s last-admin guard, so the org can never be orphaned.
   */
  async remove(actorUserId: number, orgId: string, targetUserId: number, ctx: MemberActionContext = {}) {
    const result = await this.update(actorUserId, orgId, targetUserId, { status: "inactive" }, ctx);
    await securityAuditService.record({
      action: "membership.removed",
      actorUserId,
      actorEmail: ctx.actorEmail,
      organizationId: orgId,
      targetUserId,
      ipAddress: ctx.ipAddress,
    });
    return result;
  },
};
