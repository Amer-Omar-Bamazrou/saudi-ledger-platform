/**
 * 🔴 Phase 18 R-9 — DR-22, finished (memo §2b; register §11.106): every CROSS-TENANT REFERENCE REFUSAL answered to
 * a request — 422 `reference_not_found`, thrown by a writer that proves ownership (G04) or translated from a
 * tenant-carrying foreign key — is recorded in the security trail as `reference.refused`.
 *
 * Called from the error handler, the one place every such answer passes (both of its paths: a thrown refusal and a
 * translated database refusal).
 *
 * What it stores: the actor, the organisation, the request's IP, and in the metadata the company, the method, the
 * route path (no query string), the field the refusal names, and the id asked for when that field is a scalar at
 * the top of the body or in the path (a list — `lines`, `allocations` — is not unpicked: `requested` is null).
 *
 * What it does NOT store, by decision: whether the id exists in another tenant. A refusal cannot tell foreign from
 * missing (G04), and telling them apart would mean probing other tenants' tables — the oracle G04 closed. An
 * operator reads the pattern (repeated refusals from one account) without it.
 *
 * Best-effort, on the owner connection, after the request's own transaction has rolled back with the refusal:
 * a failure to record is logged by the security service and never changes the answer.
 */
import type { Request } from "express";
import { securityAuditService } from "../services/securityAudit.service";

/** A value worth recording as "the id asked for": a finite number, or a short string. */
const scalar = (v: unknown): number | string | null =>
  (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length > 0 && v.length <= 64) ? v : null;

export function recordReferenceRefusal(req: Request, status: number, body: unknown): void {
  const b = body as { code?: unknown; field?: unknown } | null;
  if (status !== 422 || b?.code !== "reference_not_found") return;
  const field = typeof b.field === "string" ? b.field : null;
  const fromBody = field && req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>)[field] : undefined;
  const fromPath = field ? (req.params as Record<string, unknown> | undefined)?.[field] : undefined;
  void securityAuditService.record({
    action: "reference.refused",
    actorUserId: req.tenant?.userId ?? req.session?.userId ?? null,
    organizationId: req.tenant?.organizationId ?? null,
    ipAddress: req.ip ?? null,
    metadata: {
      companyId: req.tenant?.companyId ?? null,
      method: req.method,
      path: (req.originalUrl ?? req.url ?? "").split("?")[0],
      field,
      requested: scalar(fromBody) ?? scalar(fromPath),
    },
  });
}
