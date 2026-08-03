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
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors";
import { verificationRepository } from "../repositories/verification.repository";
import { securityAuditService } from "./securityAudit.service";

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

    const [companies, reviews] = await Promise.all([
      verificationRepository.listCompanies(orgId),
      verificationRepository.listReviews(orgId),
    ]);

    await securityAuditService.record({
      action: "verification.application_viewed",
      actorUserId: operatorUserId,
      actorEmail: ctx.actorEmail,
      organizationId: orgId,
      ipAddress: ctx.ipAddress,
    });

    return { ...org, companies, reviews };
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

    const fromStatus = org.status;
    const [updated] = await verificationRepository.updateVerification(orgId, {
      verificationStatus: spec.toStatus,
      verificationReason: spec.reason,
      verificationReviewedBy: operatorUserId,
      verificationReviewedAt: new Date(),
    });
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
