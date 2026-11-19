/**
 * 🔴 Phase 19A (19.8): the request a piece of work belongs to, for the code that cannot see `req` — the security-audit
 * writer above all, so EVERY security event carries the request id (the reference a user quotes and support finds in
 * the log, `X-Request-Id`) without each of its forty callers having to pass it. Set once per request, right after
 * pino-http assigns `req.id` (app.ts); empty outside a request (jobs, scripts), where the event's request id is null.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";

interface RequestContext {
  requestId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
};

/** Mounted after pino-http: every later middleware and handler runs inside the request's context. */
export function bindRequestContext(req: Request, _res: Response, next: NextFunction): void {
  const id = (req as Request & { id?: unknown }).id;
  storage.run({ requestId: typeof id === "string" ? id : null }, () => next());
}
