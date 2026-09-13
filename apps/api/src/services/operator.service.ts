/**
 * Operator service (M11.3) — the platform-operator verification review surface.
 *
 * Identity/infrastructure layer (called from the /operator router, guarded by
 * requirePlatformOperator, on the base connection BEFORE resolveTenant). It reads
 * and writes ONLY verification metadata — organization verification fields, the
 * applicant company's CR/VAT, and the review history. There is deliberately NO
 * path here to any tenant's financial data.
 *
 * State machine (operator decisions):
 *   pending_review | needs_info --approve------> approved      (clears reason)
 *   pending_review | needs_info --reject(reason)-> rejected
 *   pending_review | needs_info --request-info(reason)-> needs_info
 *   rejected -------------------- reopen(reason)-> needs_info   (mistake-correction)
 *
 * `rejected` is terminal-BY-DEFAULT: you cannot approve straight from it — an
 * operator must `reopen` it (rejected → needs_info) first. This exists so a
 * mis-click cannot permanently lock out a legitimate business.
 *
 * Every decision (a) updates the org, (b) appends a verification_reviews row, and
 * (c) writes a security_audit_logs event (operator id + target org). Guards are
 * fail-closed (wrong current state → 409; missing reason → 400; unknown org → 404).
 */
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors";
import { verificationRepository } from "../repositories/verification.repository";
import { documentsRepository } from "../repositories/documents.repository";
import { securityAuditService } from "./securityAudit.service";
// Identity data access lives in userAdmin.repository (the sanctioned identity
// layer — the boundary guard sent it there); this service only orchestrates.
import { userAdminRepository } from "../repositories/userAdmin.repository";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../lib/password";

export interface OperatorActionContext {
  actorEmail?: string | null;
  ipAddress?: string | null;
}

interface TransitionSpec {
  verb: string;
  allowedFrom: readonly string[];
  toStatus: string;
  reason: string | null;
  action: string;
}

function requireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new BadRequestError("A reason is required.");
  }
  return reason.trim();
}

export const operatorService = {
  /** The review queue: every organization not yet approved. */

  /**
   * 🔴 BREAK-GLASS PASSWORD RESET (§5 rank 1, owner decision 2026-09-04:
   * operator reset NOW, self-service email reset when the mail provider
   * lands — the 2026-08-30 record's Option C).
   *
   * This is a STANDING CROSS-TENANT ACCOUNT-TAKEOVER CAPABILITY — the
   * F1-shaped power the options record warns about — accepted KNOWINGLY as
   * the only route back for a locked-out solo admin until email exists. The
   * mitigations are structural, not promised:
   *
   *  1. The password is GENERATED, never chosen — an operator who could set
   *     "hunter2" would know a credential the user then keeps using. The
   *     caller gets it ONCE, to hand over on a verified channel, and the
   *     user should change it — unenforceable until the email flow lands,
   *     and RECORDED as such rather than pretended otherwise.
   *  2. 🔴 A PLATFORM OPERATOR CANNOT RESET ANOTHER OPERATOR — that would
   *     be operator-to-operator takeover, and operator accounts are managed
   *     at the database by the platform owner, not through this surface. The
   *     refused attempt is AUDITED TOO: a power being probed is a fact the
   *     trail must carry.
   *  3. Every live session of the target dies in the same act — a reset that
   *     leaves a hijacker's session alive would change the lock while the
   *     door stands open.
   *  4. security_audit_logs carries actor + target + ip; the password
   *     appears in NO log, NO audit row, and NO response but the one.
   */
  async resetUserPassword(operatorUserId: number, email: unknown, ctx: OperatorActionContext = {}) {
    const cleaned = String(email ?? "").trim().toLowerCase();
    if (!cleaned || !cleaned.includes("@")) throw new BadRequestError("A user email is required.");

    const target = await userAdminRepository.findByEmail(cleaned);
    if (!target) throw new NotFoundError("No user with that email.");

    if (await userAdminRepository.isPlatformOperator(target.id)) {
      await securityAuditService.record({
        action: "user.password_breakglass_refused_operator_target",
        actorUserId: operatorUserId,
        actorEmail: ctx.actorEmail,
        targetUserId: target.id,
        ipAddress: ctx.ipAddress,
      });
      throw new ForbiddenError(
        "Operator accounts cannot be reset from this surface — they are managed by the platform owner. This attempt has been recorded.",
      );
    }

    // 18 base64url chars ≈ 108 bits — comfortably past the seam's bounds and
    // typeable over a phone call, which is this flow's real delivery channel.
    const temporaryPassword = randomBytes(13).toString("base64url");
    await userAdminRepository.setPasswordHash(target.id, await hashPassword(temporaryPassword));

    // Kill every live session — same act, not a follow-up.
    const revoked = await userAdminRepository.revokeSessions(target.id);

    await securityAuditService.record({
      action: "user.password_breakglass_reset",
      actorUserId: operatorUserId,
      actorEmail: ctx.actorEmail,
      targetUserId: target.id,
      ipAddress: ctx.ipAddress,
      metadata: { sessionsRevoked: revoked },
    });

    return {
      email: target.email,
      name: target.name,
      temporaryPassword,
      sessionsRevoked: revoked,
      guidance:
        "Hand this to the user over a verified channel. It is shown once and stored nowhere. Ask them to change it after signing in — self-service reset arrives with the email flow.",
    };
  },

  async listApplications() {
    return { applications: await verificationRepository.listApplications() };
  },

  /**
   * One application's full review detail: verification header, the applicant's
   * companies (CR/VAT), and the review history. The view is audited — it is
   * cross-tenant metadata access by an operator.
   */
  async getApplication(operatorUserId: number, orgId: string, ctx: OperatorActionContext = {}) {
    const org = await verificationRepository.findOrganization(orgId);
    if (!org) throw new NotFoundError("Application not found.");

    const [companies, reviews, documents] = await Promise.all([
      verificationRepository.listCompanies(orgId),
      verificationRepository.listReviews(orgId),
      documentsRepository.listByOrg(orgId),
    ]);

    await securityAuditService.record({
      action: "verification.application_viewed",
      actorUserId: operatorUserId,
      actorEmail: ctx.actorEmail,
      organizationId: orgId,
      ipAddress: ctx.ipAddress,
    });

    return { ...org, companies, reviews, documents };
  },

  approve(operatorUserId: number, orgId: string, ctx: OperatorActionContext = {}) {
    return this._transition(operatorUserId, orgId, ctx, {
      verb: "approve",
      allowedFrom: ["pending_review", "needs_info"],
      toStatus: "approved",
      reason: null,
      action: "verification.approved",
    });
  },

  // reject/requestInfo/reopen are async so a failed reason validation surfaces as
  // a rejected promise (not a synchronous throw), consistent with the other
  // service methods and with `expect(...).rejects`.
  async reject(operatorUserId: number, orgId: string, reason: unknown, ctx: OperatorActionContext = {}) {
    return this._transition(operatorUserId, orgId, ctx, {
      verb: "reject",
      allowedFrom: ["pending_review", "needs_info"],
      toStatus: "rejected",
      reason: requireReason(reason),
      action: "verification.rejected",
    });
  },

  async requestInfo(operatorUserId: number, orgId: string, reason: unknown, ctx: OperatorActionContext = {}) {
    return this._transition(operatorUserId, orgId, ctx, {
      verb: "request info on",
      allowedFrom: ["pending_review", "needs_info"],
      toStatus: "needs_info",
      reason: requireReason(reason),
      action: "verification.needs_info",
    });
  },

  /** Mistake-correction: rejected → needs_info (rejected is otherwise terminal). */
  async reopen(operatorUserId: number, orgId: string, reason: unknown, ctx: OperatorActionContext = {}) {
    return this._transition(operatorUserId, orgId, ctx, {
      verb: "reopen",
      allowedFrom: ["rejected"],
      toStatus: "needs_info",
      reason: requireReason(reason),
      action: "verification.reopened",
    });
  },

  async _transition(
    operatorUserId: number,
    orgId: string,
    ctx: OperatorActionContext,
    spec: TransitionSpec,
  ) {
    const org = await verificationRepository.findOrganization(orgId);
    if (!org) throw new NotFoundError("Application not found.");
    if (!spec.allowedFrom.includes(org.status)) {
      throw new ConflictError(`Cannot ${spec.verb} an application in '${org.status}' state.`);
    }

    // The read above gives a precise error message; the UPDATE below re-asserts
    // the same guard ATOMICALLY so a concurrent decision cannot slip through the
    // check-then-act window (M11.5.1).
    const fromStatus = org.status;
    const [updated] = await verificationRepository.updateVerificationIfInState(orgId, spec.allowedFrom, {
      verificationStatus: spec.toStatus,
      verificationReason: spec.reason,
      verificationReviewedBy: operatorUserId,
      verificationReviewedAt: new Date(),
    });
    if (!updated) {
      // Lost a race with another operator decision between the read and the write.
      throw new ConflictError(
        `Cannot ${spec.verb} this application — its status changed. Please reload and retry.`,
      );
    }
    await verificationRepository.insertReview({
      organizationId: orgId,
      operatorUserId,
      fromStatus,
      toStatus: spec.toStatus,
      reason: spec.reason,
    });
    await securityAuditService.record({
      action: spec.action,
      actorUserId: operatorUserId,
      actorEmail: ctx.actorEmail,
      organizationId: orgId,
      metadata: { fromStatus, toStatus: spec.toStatus, reason: spec.reason },
      ipAddress: ctx.ipAddress,
    });
    return { organizationId: orgId, status: updated.status, reason: updated.reason };
  },
};
