/**
 * User-administration service (M11.5.1 SECURITY HOTFIX).
 *
 * WHAT THIS REPLACES — the vulnerability:
 * `/auth/users*` and `/auth/register` were guarded only by `requireAdmin`, which
 * reads the ambient GLOBAL `req.session.userRole`. Two independent problems:
 *   1. That global role was made SELF-GRANTABLE by the public M11.5 signup
 *      (which wrote `users.role = "admin"`), so any anonymous caller could reach
 *      these endpoints. Fixed at the source in signup.repository/auth.ts.
 *   2. Even for a LEGITIMATE admin the endpoints were unscoped: `GET /auth/users`
 *      had no organization filter (a platform-wide identity dump) and
 *      reset-password/PATCH accepted ANY user id — so an admin of org A could
 *      read and take over org B's users. That is a cross-tenant breach of the
 *      platform's core guarantee, independent of the signup bug.
 *
 * THE MODEL NOW: authorization is EXPLICIT and ORG-SCOPED, mirroring M10.6's
 * `assertOrgAdmin` — the actor must be an ACTIVE ADMIN of at least one
 * organization, and may only see/modify users who are members of an organization
 * THEY administer. No ambient global role is trusted anywhere in this file.
 *
 * LAYER: identity/infrastructure — runs before `resolveTenant` on the base
 * connection, so there is no RLS backstop; authorization here is the only gate.
 */
import { assertPasswordAcceptable, hashPassword } from "../lib/password";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors";
import { userAdminRepository } from "../repositories/userAdmin.repository";
import { assertAccountConfinedTo } from "../lib/accountScope";
import { securityAuditService } from "./securityAudit.service";


/** The only roles accepted for the global `users.role` column. */
export const VALID_USER_ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
export type UserRoleValue = (typeof VALID_USER_ROLES)[number];

export interface ActorContext {
  actorEmail?: string | null;
  ipAddress?: string | null;
}

export function safeUser(u: {
  id: number; email: string; name: string; role: string; isActive: boolean; createdAt: Date;
}) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role,
    isActive: u.isActive, createdAt: u.createdAt.toISOString(),
  };
}

/**
 * The actor must actively administer at least one APPROVED organization.
 * Returns those org ids — the scope every operation below is confined to.
 * (Approved-only because `/auth/*` sits outside the M11.2 verification gate —
 * see the repository for why an unverified org must not administer users.)
 */
async function requireAdminScope(actorUserId: number): Promise<string[]> {
  const orgIds = await userAdminRepository.administeredOrgIds(actorUserId);
  if (orgIds.length === 0) {
    throw new ForbiddenError(
      "You must be an admin of a verified organization to manage users.",
    );
  }
  return orgIds;
}

/** The target must be a member of an organization the actor administers. */
/**
 * The target must be administrable by this actor. TWO conditions, and F1 is the
 * lesson that the first alone is not a boundary:
 *
 *   1. IN SCOPE — the target shares an organization with the actor. Failing
 *      this is concealed as 404: do not confirm the existence of users outside
 *      the caller's scope (that would restore the cross-tenant enumeration
 *      M11.5.1 removed).
 *
 *   2. 🔴 CONFINED — the target belongs to NO organization outside the actor's
 *      scope. Condition 1 was written as the tenant boundary and is not one:
 *      the actor can CREATE the sharing it tests, via
 *      `POST /orgs/:orgId/members`, for any user id that exists. Password reset
 *      and deactivation are acts on a platform-wide account, so they need the
 *      condition the actor cannot manufacture. See lib/accountScope.ts.
 */
async function assertTargetAdministrable(targetUserId: number, orgIds: string[]): Promise<void> {
  if (!(await userAdminRepository.isMemberOfAny(targetUserId, orgIds))) {
    throw new NotFoundError("User not found.");
  }
  await assertAccountConfinedTo(targetUserId, orgIds, "explain");
}

export const userAdminService = {
  /** Users in the actor's own organization(s) — never the whole platform. */
  async list(actorUserId: number) {
    const orgIds = await requireAdminScope(actorUserId);
    return (await userAdminRepository.listUsersInOrgs(orgIds)).map(safeUser);
  },

  /**
   * Create a global user account. The caller must administer an organization;
   * the new account has NO membership until one is assigned via
   * `/orgs/:orgId/members`, so it grants no access on its own.
   */
  async create(
    actorUserId: number,
    input: { email?: unknown; name?: unknown; password?: unknown; role?: unknown },
    ctx: ActorContext = {},
  ) {
    await requireAdminScope(actorUserId);

    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    const role = (input.role ?? "viewer") as UserRoleValue;

    if (!email || !name || !password) {
      throw new BadRequestError("email, name, and password are required.");
    }
    if (!VALID_USER_ROLES.includes(role)) {
      throw new BadRequestError(`Invalid role. Must be ${VALID_USER_ROLES.join(", ")}.`);
    }
    assertPasswordAcceptable(password);
    if (await userAdminRepository.findByEmail(email)) {
      throw new ConflictError("Email already registered.");
    }

    const passwordHash = await hashPassword(password);
    const [user] = await userAdminRepository.insert({ email, name, passwordHash, role, isActive: true });
    await securityAuditService.record({
      action: "user.created",
      actorUserId, actorEmail: ctx.actorEmail, targetUserId: user.id,
      metadata: { email: user.email, role: user.role }, ipAddress: ctx.ipAddress,
    });
    return safeUser(user);
  },

  /** Change a user's global role / active flag / name — scoped to the actor's orgs. */
  async update(
    actorUserId: number,
    targetUserId: number,
    changes: { role?: unknown; isActive?: unknown; name?: unknown },
    ctx: ActorContext = {},
  ) {
    const orgIds = await requireAdminScope(actorUserId);
    await assertTargetAdministrable(targetUserId, orgIds);

    const updates: { role?: UserRoleValue; isActive?: boolean; name?: string } = {};
    if (changes.role !== undefined) {
      // Role-enum validation (previously missing here, unlike /auth/register —
      // `users.role` is a plain text column with no DB CHECK constraint, so an
      // arbitrary string could be written).
      if (!VALID_USER_ROLES.includes(changes.role as UserRoleValue)) {
        throw new BadRequestError(`Invalid role. Must be ${VALID_USER_ROLES.join(", ")}.`);
      }
      updates.role = changes.role as UserRoleValue;
    }
    if (changes.isActive !== undefined) {
      if (typeof changes.isActive !== "boolean") throw new BadRequestError("isActive must be a boolean.");
      updates.isActive = changes.isActive;
    }
    if (changes.name !== undefined) {
      const name = typeof changes.name === "string" ? changes.name.trim() : "";
      if (!name) throw new BadRequestError("name must be a non-empty string.");
      updates.name = name;
    }
    if (Object.keys(updates).length === 0) throw new BadRequestError("No changes supplied.");

    const before = await userAdminRepository.findById(targetUserId);
    if (!before) throw new NotFoundError("User not found.");
    const [user] = await userAdminRepository.update(targetUserId, updates);

    const actor = { actorUserId, actorEmail: ctx.actorEmail, ipAddress: ctx.ipAddress };
    if (updates.role !== undefined && user.role !== before.role) {
      await securityAuditService.record({
        action: "user.role_changed", ...actor, targetUserId,
        metadata: { before: before.role, after: user.role },
      });
    }
    if (updates.isActive !== undefined && user.isActive !== before.isActive) {
      await securityAuditService.record({
        action: user.isActive ? "user.reactivated" : "user.deactivated", ...actor, targetUserId,
      });
    }
    return safeUser(user);
  },

  /** Reset another user's password — scoped to the actor's organizations. */
  async resetPassword(
    actorUserId: number,
    targetUserId: number,
    newPassword: unknown,
    ctx: ActorContext = {},
  ) {
    const orgIds = await requireAdminScope(actorUserId);
    await assertTargetAdministrable(targetUserId, orgIds);

    assertPasswordAcceptable(newPassword, "newPassword");
    const passwordHash = await hashPassword(newPassword, "newPassword");
    const [user] = await userAdminRepository.update(targetUserId, { passwordHash });
    if (!user) throw new NotFoundError("User not found.");

    await securityAuditService.record({
      action: "user.password_reset",
      actorUserId, actorEmail: ctx.actorEmail, targetUserId, ipAddress: ctx.ipAddress,
    });
    return { message: `Password reset for ${user.name}.` };
  },
};
