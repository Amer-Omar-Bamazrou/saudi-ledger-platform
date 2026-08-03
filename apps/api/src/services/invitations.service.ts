/**
 * Invitations service (M11.7) — how an APPROVED organization adds its team.
 *
 * ── Threat model (this is a PUBLIC endpoint that mints a membership) ─────────
 * The accept path can create a user AND grant an organization membership without
 * an existing session. That is exactly the "self-grantable capability" shape that
 * caused the M11.5.1 CRITICAL, so the invariants below are deliberate and each is
 * covered by a regression test:
 *
 *  1. NO GLOBAL PRIVILEGE. A user created by accepting gets the vestigial global
 *     `users.role = "viewer"`. The invited role is written to the MEMBERSHIP
 *     only — that is what governs access (`resolveTenant` → `requirePermission`).
 *     Nothing authorizes off `users.role` today; writing a privileged value here
 *     would re-arm that trap for any future guard.
 *  2. NO ROLE ESCALATION. `role` is validated against VALID_MEMBERSHIP_ROLES
 *     (fail closed). Only an org ADMIN can invite, and admin is the highest org
 *     role, so no invite can grant more than the inviter holds. Platform-operator
 *     status lives in a different table and is unreachable from here.
 *  3. APPROVED ORG ONLY — enforced when sending AND again when accepting. An
 *     unverified org must not mint accounts for arbitrary email addresses (that
 *     is the email-squatting vector M11.5.1 closed for `/auth/register`), and an
 *     org rejected between send and accept must not gain a new member.
 *  4. NO DOUBLE REDEMPTION. Acceptance claims the invitation with a conditional
 *     UPDATE (`status='pending' AND expires_at > now()`); zero rows ⇒ 409.
 *  5. IDENTITY BINDING. A logged-in acceptor's session email must equal the
 *     invited email (case-insensitive), so a token cannot be redeemed by whoever
 *     happens to hold the link while signed in as someone else.
 */
import bcrypt from "bcryptjs";
import { loadEnv } from "@workspace/config";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors";
import { generateToken, hashToken } from "../lib/tokens";
import { mailer } from "../lib/mailer";
import { invitationsRepository } from "../repositories/invitations.repository";
import { membersRepository } from "../repositories/members.repository";
import { userAdminRepository } from "../repositories/userAdmin.repository";
import { VALID_MEMBERSHIP_ROLES, type MembershipRole } from "./members.service";
import { securityAuditService } from "./securityAudit.service";

// Must match apps/api/src/routes/auth.ts SALT_ROUNDS.
const SALT_ROUNDS = 12;
const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

export interface ActorContext {
  actorEmail?: string | null;
  ipAddress?: string | null;
}

function inviteExpiry(): Date {
  const { INVITATION_EXPIRY_DAYS } = loadEnv();
  return new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

function inviteLink(token: string): string {
  const env = loadEnv();
  const base = (env.APP_BASE_URL ?? env.CORS_ALLOWED_ORIGINS[0] ?? "").replace(/\/+$/, "");
  return `${base}/accept-invite?token=${encodeURIComponent(token)}`;
}

/**
 * The actor must be an active admin of THIS org (M10.6 pattern — never ambient
 * context) AND the org must be verification-`approved` (invariant 3).
 */
async function assertApprovedOrgAdmin(actorUserId: number, orgId: string): Promise<void> {
  const role = await membersRepository.activeRole(actorUserId, orgId);
  if (role !== "admin") {
    throw new ForbiddenError("You must be an admin of this organization to manage invitations.");
  }
  const approved = await userAdminRepository.administeredOrgIds(actorUserId);
  if (!approved.includes(orgId)) {
    throw new ForbiddenError(
      "Your organization must be verified before you can invite team members.",
    );
  }
}

export const invitationsService = {
  async list(actorUserId: number, orgId: string) {
    await assertApprovedOrgAdmin(actorUserId, orgId);
    return { invitations: await invitationsRepository.listByOrg(orgId) };
  },

  /** Create a pending invitation and return the shareable link. */
  async send(actorUserId: number, orgId: string, emailInput: unknown, roleInput: unknown, ctx: ActorContext = {}) {
    await assertApprovedOrgAdmin(actorUserId, orgId);

    const email = typeof emailInput === "string" ? emailInput.trim().toLowerCase() : "";
    if (!email || !EMAIL_RE.test(email)) throw new BadRequestError("A valid email address is required.");

    const role = roleInput as MembershipRole;
    if (!VALID_MEMBERSHIP_ROLES.includes(role)) {
      throw new BadRequestError(`role must be one of: ${VALID_MEMBERSHIP_ROLES.join(", ")}.`);
    }

    // Already on the team? Nothing to invite.
    const existingUser = await invitationsRepository.findUserByEmail(email);
    if (existingUser) {
      const membership = await membersRepository.activeRole(existingUser.id, orgId);
      if (membership) throw new ConflictError("That person is already a member of this organization.");
    }
    if (await invitationsRepository.findPendingByEmail(orgId, email)) {
      throw new ConflictError("An invitation is already pending for that email. Resend or revoke it.");
    }

    const token = generateToken();
    const [invitation] = await invitationsRepository.insert({
      organizationId: orgId,
      email,
      role,
      tokenHash: hashToken(token),
      invitedByUserId: actorUserId,
      status: "pending",
      expiresAt: inviteExpiry(),
    });

    const link = inviteLink(token);
    const { delivered } = await mailer.send({
      to: email,
      subject: "You have been invited to join an organization",
      text: `You have been invited to join an organization on KSA Ledger. Accept here: ${link}`,
    });

    await securityAuditService.record({
      action: "invite.sent",
      actorUserId, actorEmail: ctx.actorEmail, organizationId: orgId,
      metadata: { invitationId: invitation.id, email, role },
      ipAddress: ctx.ipAddress,
    });

    // The raw token is returned exactly once, here — it is never persisted and
    // never retrievable again (only its hash is stored).
    return {
      id: invitation.id, email, role, status: invitation.status,
      expiresAt: invitation.expiresAt, link, emailDelivered: delivered,
    };
  },

  async revoke(actorUserId: number, orgId: string, invitationId: string, ctx: ActorContext = {}) {
    await assertApprovedOrgAdmin(actorUserId, orgId);
    const existing = await invitationsRepository.findInOrg(invitationId, orgId);
    if (!existing) throw new NotFoundError("Invitation not found.");

    const [revoked] = await invitationsRepository.revoke(invitationId, orgId);
    if (!revoked) throw new ConflictError(`Cannot revoke an invitation in '${existing.status}' state.`);

    await securityAuditService.record({
      action: "invite.revoked",
      actorUserId, actorEmail: ctx.actorEmail, organizationId: orgId,
      metadata: { invitationId, email: existing.email },
      ipAddress: ctx.ipAddress,
    });
    return { id: invitationId, status: "revoked" as const };
  },

  /** Issue a fresh token + expiry for a pending invitation (the old link dies). */
  async resend(actorUserId: number, orgId: string, invitationId: string, ctx: ActorContext = {}) {
    await assertApprovedOrgAdmin(actorUserId, orgId);
    const existing = await invitationsRepository.findInOrg(invitationId, orgId);
    if (!existing) throw new NotFoundError("Invitation not found.");
    if (existing.status !== "pending") {
      throw new ConflictError(`Cannot resend an invitation in '${existing.status}' state.`);
    }

    const token = generateToken();
    const expiresAt = inviteExpiry();
    const [reissued] = await invitationsRepository.reissue(invitationId, hashToken(token), expiresAt);
    if (!reissued) throw new ConflictError("This invitation is no longer pending.");

    const link = inviteLink(token);
    const { delivered } = await mailer.send({
      to: existing.email,
      subject: "Your invitation link",
      text: `Accept your invitation here: ${link}`,
    });

    await securityAuditService.record({
      action: "invite.resent",
      actorUserId, actorEmail: ctx.actorEmail, organizationId: orgId,
      metadata: { invitationId, email: existing.email },
      ipAddress: ctx.ipAddress,
    });
    return { id: invitationId, email: existing.email, expiresAt, link, emailDelivered: delivered };
  },

  /**
   * PUBLIC preview of an invite link — just enough for the accept page to render
   * (org name, invited email, role, whether an account already exists). Reveals
   * nothing an invite holder shouldn't already know.
   */
  async preview(token: unknown) {
    const invitation = await this._loadValid(token);
    const existingUser = await invitationsRepository.findUserByEmail(invitation.email);
    return {
      organizationName: invitation.organizationName,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      hasAccount: !!existingUser,
    };
  },

  /**
   * PUBLIC accept. Two paths:
   *  - signed in  → the session email must match the invite email;
   *  - no account → name + password create the user atomically with the membership.
   * Returns the identity to log in as.
   */
  async accept(
    token: unknown,
    input: { name?: unknown; password?: unknown },
    sessionUserId: number | null,
    ctx: ActorContext = {},
  ) {
    const invitation = await this._loadValid(token);
    const email = invitation.email;

    let userId: number;
    let userName: string;

    const existingUser = await invitationsRepository.findUserByEmail(email);

    if (sessionUserId) {
      // Signed-in path — the session must BE the invited person (invariant 5).
      const actor = await userAdminRepository.findById(sessionUserId);
      if (!actor || actor.email.toLowerCase() !== email) {
        throw new ForbiddenError(
          "This invitation was sent to a different email address. Sign out and accept it as that user.",
        );
      }
      userId = actor.id;
      userName = actor.name;
    } else if (existingUser) {
      // An account exists but nobody is signed in — do NOT create a session from
      // a link alone; require them to authenticate first.
      throw new ConflictError(
        "An account already exists for this email. Please sign in first, then open the invitation link.",
      );
    } else {
      // New-account path.
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const password = typeof input.password === "string" ? input.password : "";
      if (!name) throw new BadRequestError("Your full name is required.");
      if (password.length < MIN_PASSWORD) {
        throw new BadRequestError(`Password must be at least ${MIN_PASSWORD} characters.`);
      }
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      // Invariant 1: global role is NON-PRIVILEGED. Authority comes from the
      // membership created below.
      const [created] = await userAdminRepository.insert({
        email, name, passwordHash, role: "viewer", isActive: true,
      });
      userId = created.id;
      userName = created.name;
    }

    // Already a member? Don't silently re-grant or change their role.
    if (await membersRepository.activeRole(userId, invitation.organizationId)) {
      throw new ConflictError("You are already a member of this organization.");
    }

    // Invariant 4: claim atomically BEFORE granting the membership, so a raced
    // double-accept cannot produce two memberships.
    const [claimed] = await invitationsRepository.claim(invitation.id, userId);
    if (!claimed) throw new ConflictError("This invitation is no longer valid.");

    await membersRepository.upsert(userId, invitation.organizationId, invitation.role);

    await securityAuditService.record({
      action: "invite.accepted",
      actorUserId: userId, actorEmail: email, organizationId: invitation.organizationId,
      targetUserId: userId,
      metadata: { invitationId: invitation.id, role: invitation.role },
      ipAddress: ctx.ipAddress,
    });

    return {
      userId, email, name: userName,
      organizationId: invitation.organizationId,
      role: invitation.role,
    };
  },

  /** Resolve + validate a token: exists, pending, unexpired, org still approved. */
  async _loadValid(token: unknown) {
    if (typeof token !== "string" || token.length === 0) {
      throw new BadRequestError("An invitation token is required.");
    }
    const invitation = await invitationsRepository.findByTokenHash(hashToken(token));
    // Same 404 for "no such token" and "wrong token" — do not confirm guesses.
    if (!invitation) throw new NotFoundError("This invitation link is not valid.");
    if (invitation.status !== "pending") {
      throw new ConflictError(`This invitation has already been ${invitation.status}.`);
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError("This invitation has expired. Ask an admin to send a new one.");
    }
    // Invariant 3, re-checked at accept time.
    if (invitation.verificationStatus !== "approved") {
      throw new ForbiddenError("This organization is not currently active.");
    }
    return invitation;
  },
};
