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
import { count, desc, eq } from "drizzle-orm";
// 🔴 The OWNER connection, named deliberately rather than inherited.
// `security_audit_logs` is an owner-only table — likewise already listed on `ownerDb`, and likewise reached through the fallback.
// The `db` proxy now REFUSES a query outside a tenant transaction rather than
// falling back here silently, so this import states what was previously assumed.
import { ownerDb as db, securityAuditLogsTable } from "@workspace/db";
import { ForbiddenError } from "../lib/errors";
import { alerter } from "../lib/alerter";
import { logger } from "../lib/logger";
import { requestContext } from "../lib/requestContext";
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
  // 🔴 Phase 19A (19.8) — the vocabulary, closed in PHASE19A_SECURITY_EVENTS below
  | Phase19aSecurityEvent
  // Open-ended: later milestones add verification.* / invite.* / operator.* .
  | (string & {});

/**
 * 🔴 Phase 19A (19.8, owner approval 2026-11-17): the security events 19A's acts write — each act EXACTLY ONE, with
 * actor, target, organization and the request id. The web's event list labels every one in both languages (a test
 * holds the two lists together). Written as each act is built: the session acts in slice 1, MFA in slice 2, the
 * security settings in slice 3.
 */
export const PHASE19A_SECURITY_EVENTS = [
  "session.revoked",
  "session.revoked_all",
  "mfa.enrolled",
  "mfa.activated",
  "mfa.verified",
  "mfa.failed",
  "mfa.recovery_code_used",
  "mfa.reset",
  "security_settings.changed",
] as const;
export type Phase19aSecurityEvent = (typeof PHASE19A_SECURITY_EVENTS)[number];

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

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

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
        // 19.8: the request that wrote it, from the request's own context (never from the client)
        requestId: requestContext.get()?.requestId ?? null,
        targetUserId: input.targetUserId ?? null,
        metadata: (input.metadata ?? null) as SecurityEventInput["metadata"],
        ipAddress: input.ipAddress ?? null,
      });
    } catch (err) {
      // 🔴 L-1: a security event that fails to record is the "unnoticed"
      // multiplier — an identity mutation has committed with no trail, and a
      // console line is read by nobody. Still never thrown (the mutation is
      // already real); instead it PAGES, because quiet neglect needs an
      // alarm, not a dashboard. The alert itself is belt-wrapped: an alerting
      // failure must not turn a committed mutation into a reported error.
      logger.error({ action: input.action, targetUserId: input.targetUserId ?? null, err }, "security-audit write FAILED — event not recorded");
      try {
        await alerter.fire({
          key: "security-audit-write-failed",
          severity: "critical",
          title: "A security-audit event failed to record",
          detail: `The '${input.action}' event could not be written to security_audit_logs; the mutation it describes has already committed. Investigate the table and the events around this time.`,
          context: { action: input.action },
        });
      } catch (alertErr) {
        logger.error({ err: alertErr }, "failed to page on a security-audit write failure");
      }
    }
  },

  /**
   * One PAGE of an organization's security events, newest first, with the organization's total. Explicitly authorized:
   * the caller must be an active admin of THIS org (identity-layer pattern — no
   * ambient tenant context). Only events scoped to the org are returned; global
   * (org-less) events are not exposed here (a platform-operator surface reads
   * those in a later milestone).
   *
   * 🔴 Phase 18 audit A2: this returned the newest 100 rows and nothing else — no total, no way to the 101st — so a
   * reader shown 100 rows could not tell there were more. A page is 50 by default and 200 at most; ties on the time
   * are broken by id, so the pages together are every row exactly once.
   */
  async listForOrg(actorUserId: number, orgId: string, page: { limit?: number; offset?: number } = {}) {
    const role = await membersRepository.activeRole(actorUserId, orgId);
    if (role !== "admin") {
      throw new ForbiddenError("You must be an admin of this organization to view its security events.");
    }
    const limit = Number.isInteger(page.limit) && page.limit! > 0 ? Math.min(page.limit!, MAX_PAGE) : DEFAULT_PAGE;
    const offset = Number.isInteger(page.offset) && page.offset! > 0 ? page.offset! : 0;
    const ofOrg = eq(securityAuditLogsTable.organizationId, orgId);
    const [events, [counted]] = await Promise.all([
      db.select().from(securityAuditLogsTable).where(ofOrg)
        .orderBy(desc(securityAuditLogsTable.createdAt), desc(securityAuditLogsTable.id))
        .limit(limit).offset(offset),
      db.select({ total: count() }).from(securityAuditLogsTable).where(ofOrg),
    ]);
    return { events, total: Number(counted?.total ?? 0), limit, offset };
  },
};
