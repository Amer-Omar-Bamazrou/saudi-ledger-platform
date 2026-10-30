/**
 * Audit service (M7) — the single mechanism that records business mutations to
 * `audit_logs`. Called from the service layer at each mutating operation, inside
 * the request's tenant transaction, so an audit row commits atomically WITH the
 * mutation (a rolled-back request records nothing — we only log what committed).
 *
 * Org/IP come from the request's {@link auditContext} (AsyncLocalStorage), and
 * the actor from the transaction itself (T1b), so callers only describe WHAT
 * changed, never WHO/WHERE. The `action` is a free
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
      // 🔴 T1b (G25): NO `userId`. The row names the connection's declared
      // actor (`TenantScope.actorUserId`; the column defaults to it, and the
      // database refuses any other user — migration 0132), so this service
      // cannot write a user it was handed.
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

  /**
   * 🔴 Phase 18 H-14 — DR-22 (register §11.65): the POSTING SEAM's record of an
   * entry it posted (contract §8.6 items 1–2: document entries, depreciation).
   * Unlike `record`, it needs no request context: the seam is reached from
   * requests, scripts and tests alike, and a posting must never go unrecorded
   * — or fail — because its caller had none. The organization is the entry's;
   * the user is the connection's declared actor (the column's default — T1b —
   * so none for a script); the IP is the request's when there is one. Only the
   * seam calls this; every other record still goes through `record`.
   */
  async postedEntry(organizationId: string, entryId: number, after: Record<string, unknown>): Promise<void> {
    await db.insert(auditLogsTable).values({
      organizationId,
      action: "post",
      entityType: "journal_entry",
      entityId: String(entryId),
      afterState: after,
      ipAddress: auditContext.get()?.ipAddress ?? null,
    });
  },
};
