/**
 * Audit service (M7) — the single mechanism that records business mutations to
 * `audit_logs`. Called from the service layer at each mutating operation, inside
 * the request's tenant transaction, so an audit row commits atomically WITH the
 * mutation (a rolled-back request records nothing — we only log what committed).
 *
 * Actor/org/IP come from the request's {@link auditContext} (AsyncLocalStorage),
 * so callers only describe WHAT changed, never WHO/WHERE. The `action` is a free
 * string (create | update | delete today; the future draft/approval workflow can
 * emit `submit`/`approve`/`reject`/`post` through this same service unchanged).
 *
 * A failed audit insert propagates and rolls the mutation back — there is no
 * "mutation without an audit trail".
 */
import { db, auditLogsTable } from "@workspace/db";
import { auditContext } from "../lib/auditContext";

export type AuditAction = "create" | "update" | "delete" | (string & {});

export interface AuditRecordInput {
  action: AuditAction;
  entityType: string;
  entityId: string | number;
  /** Prior row snapshot — for update/delete. */
  before?: unknown;
  /** Resulting row snapshot — for create/update. */
  after?: unknown;
}

export const auditService = {
  async record(input: AuditRecordInput): Promise<void> {
    const ctx = auditContext.get();
    if (!ctx) {
      throw new Error("auditService.record called outside an audited request context");
    }
    await db.insert(auditLogsTable).values({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: String(input.entityId),
      beforeState: (input.before ?? null) as unknown as Record<string, unknown> | null,
      afterState: (input.after ?? null) as unknown as Record<string, unknown> | null,
      ipAddress: ctx.ipAddress,
    });
  },

  created(entityType: string, entityId: string | number, after: unknown): Promise<void> {
    return this.record({ action: "create", entityType, entityId, after });
  },
  updated(entityType: string, entityId: string | number, before: unknown, after: unknown): Promise<void> {
    return this.record({ action: "update", entityType, entityId, before, after });
  },
  deleted(entityType: string, entityId: string | number, before: unknown): Promise<void> {
    return this.record({ action: "delete", entityType, entityId, before });
  },
};
