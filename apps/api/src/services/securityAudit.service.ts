/**
 * Security-audit service (M11.1) — records identity & security events to
 * `security_audit_logs`, and reads them back for an org's admins.
 *
 * This is the identity-layer counterpart to the business {@link auditService}.
 * The two are deliberately different because their contexts differ:
 *
 *   - `auditService` runs INSIDE the request's tenant transaction (as the app
 *     role), so its write commits atomically with the mutation and it THROWS on
 *     failure (rolling the mutation back — no "mutation without an audit trail").
 *   - Security events happen in the identity/infrastructure layer, BEFORE
 *     `resolveTenant`, on the base/owner connection and OUTSIDE any surrounding
 *     transaction (each identity write autocommits). A failed security-audit
 *     insert therefore MUST NOT be thrown to the caller: the mutation it
 *     describes has already committed, so throwing would report a successful
 *     operation as failed. Instead we record best-effort and log on failure.
 *     (Making identity mutations transactional so the event commits atomically
 *     with them is a documented follow-up, tracked with the wider onboarding
 *     work — not required for the foundation.)
 *
 * Like `auditService`, this infra service accesses `db` directly (it is not a
 * business domain with a repository). Because it runs before `resolveTenant`,
 * `db` resolves to the base/owner connection.
 *
 * NEVER put secrets in `metadata` — no password material, no tokens.
 */
import { desc, eq } from "drizzle-orm";
import { db, securityAuditLogsTable } from "@workspace/db";
import { ForbiddenError } from "../lib/errors";
import { membersRepository } from "../repositories/members.repository";

export type SecurityAuditAction =
  | "user.created"
  | "user.role_changed"
  | "user.deactivated"
  | "user.reactivated"
  | "user.password_reset"
  | "user.password_changed"
  | "membership.assigned"
  | "membership.role_changed"
  | "membership.status_changed"
  // Open-ended: later milestones add verification.* / invite.* / operator.* .
  | (string & {});

export interface SecurityEventInput {
  action: SecurityAuditAction;
  /** Who performed it (null for anonymous/system). */
  actorUserId?: number | null;
  /** Denormalized actor email snapshot, when known. */
  actorEmail?: string | null;
  /** Target organization (null for global identity events). */
  organizationId?: string | null;
  /** The user the action concerns, when applicable. */
  targetUserId?: number | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export const securityAuditService = {
  /**
   * Record a security event. Best-effort: a failure is logged, never thrown, so
   * it cannot turn an already-committed identity mutation into a reported error.
   */
  async record(input: SecurityEventInput): Promise<void> {
    try {
      await db.insert(securityAuditLogsTable).values({
        action: input.action,
        actorUserId: input.actorUserId ?? null,
        actorEmail: input.actorEmail ?? null,
        organizationId: input.organizationId ?? null,
        targetUserId: input.targetUserId ?? null,
        metadata: (input.metadata ?? null) as SecurityEventInput["metadata"],
        ipAddress: input.ipAddress ?? null,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[security-audit] failed to record event", { action: input.action, err });
    }
  },

  /**
   * List an organization's security events, newest first. Explicitly authorized:
   * the caller must be an active admin of THIS org (identity-layer pattern — no
   * ambient tenant context). Only events scoped to the org are returned; global
   * (org-less) events are not exposed here (a platform-operator surface reads
   * those in a later milestone).
   */
  async listForOrg(actorUserId: number, orgId: string, limit = 100) {
    const role = await membersRepository.activeRole(actorUserId, orgId);
    if (role !== "admin") {
      throw new ForbiddenError("You must be an admin of this organization to view its security events.");
    }
    return db
      .select()
      .from(securityAuditLogsTable)
      .where(eq(securityAuditLogsTable.organizationId, orgId))
      .orderBy(desc(securityAuditLogsTable.createdAt))
      .limit(limit);
  },
};
