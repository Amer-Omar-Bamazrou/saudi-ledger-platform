/**
 * Per-request audit context (actor, org, IP), propagated via AsyncLocalStorage.
 *
 * Set once by `resolveTenant` (wrapping the request), so the audit service can
 * stamp who/where without threading `req` through controllers and services.
 * This mirrors the tenant-scoped DB context and lives for the same request.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface AuditContext {
  /** Acting user id (null for system actions — not used on the request path). */
  userId: number | null;
  /** Active organization (tenant) — required; every audit row is org-scoped. */
  organizationId: string;
  /** Client IP address, if resolvable. */
  ipAddress: string | null;
}

const storage = new AsyncLocalStorage<AuditContext>();

export const auditContext = {
  /** Run `fn` (and its async continuation) with `ctx` bound. */
  run<T>(ctx: AuditContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  /** The current request's audit context, or undefined outside a request. */
  get(): AuditContext | undefined {
    return storage.getStore();
  },
};
