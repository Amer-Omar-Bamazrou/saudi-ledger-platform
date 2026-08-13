/**
 * RBAC — centralized, data-driven authorization for business routes.
 *
 * `requirePermission(resource)` is the single authorization seam. It reads the
 * caller's role from the resolved tenant context (`req.tenant.role`, the active
 * organization-membership role set by `resolveTenant` — never the global
 * `users.role`), infers the action from the HTTP method, and checks the pair
 * against the seeded `permissions` table (role → resource → action).
 *
 * ACTION-ROUTE OVERRIDE (M10): approver-only endpoints are POSTs
 * (`/:id/post`, `/:id/approve`, `/:id/pay`, `/:id/reject`, `/:id/reverse`,
 * `/:id/send-back`) that would otherwise resolve to `create` — which a
 * bookkeeper holds. They instead resolve to the distinct `approve` action, so
 * "may enter a draft" and "may activate/decide it" are separately grantable.
 * Plain `POST /` (create) and `POST /:id/submit` (a bookkeeper submitting their
 * own draft into the approval queue) are deliberately NOT overridden — they stay
 * `create`, which a bookkeeper holds.
 *
 * Policy lives in DATA (the `permissions` table, seeded from `PERMISSION_MATRIX`
 * in @workspace/db), not in code — a future phase changes access by re-seeding.
 * The check is FAIL-CLOSED: if no matching grant exists, access is denied.
 *
 * The mapping is loaded once into an in-memory cache (permissions are global
 * reference data seeded at deploy). Restart the process to pick up re-seeds.
 */
import type { Request, Response, NextFunction } from "express";
import { db, permissionsTable, type PermissionAction } from "@workspace/db";

/** HTTP method → permission action. */
const METHOD_ACTION: Record<string, PermissionAction> = {
  GET: "read",
  HEAD: "read",
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
};

// Approver-only sub-routes: a POST whose path ends in one of these verbs
// requires the `approve` action rather than `create`. `submit` is intentionally
// absent — it is a bookkeeper's own action (create-level). Matched on the path
// SUFFIX so it is robust to Express mount-path stripping (works on "/5/approve"
// or "/x/5/approve" alike). `send-back` is matched with an optional hyphen.
// `settle` (M16.3) fires a payment through the invoice/bill pay path, so it
// carries the same approver-only authority as `pay`.
const APPROVE_ROUTE = /\/(?:post|approve|pay|reject|reverse|send-?back|settle)\/?$/i;

/** Resolve the permission action for a request (method + activation-route override). */
function resolveAction(req: Request): PermissionAction | undefined {
  if (req.method === "POST" && APPROVE_ROUTE.test(req.path)) return "approve";
  return METHOD_ACTION[req.method];
}

const permKey = (role: string, resource: string, action: string): string =>
  `${role}:${resource}:${action}`;

// Cache of allowed `role:resource:action` keys. `loading` de-dupes concurrent
// first-load requests so the table is read once.
let cache: Set<string> | null = null;
let loading: Promise<Set<string>> | null = null;

async function loadFromDb(): Promise<Set<string>> {
  const rows = await db
    .select({
      role: permissionsTable.role,
      resource: permissionsTable.resource,
      action: permissionsTable.action,
    })
    .from(permissionsTable);
  return new Set(rows.map((r) => permKey(r.role, r.resource, r.action)));
}

async function getPermissions(): Promise<Set<string>> {
  if (cache) return cache;
  if (!loading) {
    loading = loadFromDb()
      .then((set) => {
        cache = set;
        loading = null;
        return set;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

/**
 * Ask whether a role holds a (resource, action) grant — the same matrix
 * `requirePermission` enforces, exposed for in-handler decisions (e.g. an
 * approver self-approving on create). Reads the shared in-memory cache, so it
 * duplicates no policy.
 */
export async function can(role: string, resource: string, action: PermissionAction): Promise<boolean> {
  const permissions = await getPermissions();
  return permissions.has(permKey(role, resource, action));
}

/** Test/ops hook: seed the cache directly (bypasses the DB). */
export function primePermissionCache(
  rows: ReadonlyArray<{ role: string; resource: string; action: string }>,
): void {
  cache = new Set(rows.map((r) => permKey(r.role, r.resource, r.action)));
  loading = null;
}

/** Test/ops hook: clear the cache so the next check re-reads the DB. */
export function resetPermissionCache(): void {
  cache = null;
  loading = null;
}

/**
 * Guard a route/resource. Must run AFTER `resolveTenant` (needs `req.tenant`).
 * Returns 403 if the active-org role lacks the (resource, action) grant.
 */
export function requirePermission(resource: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const role = req.tenant?.role;
    if (!role) {
      res.status(403).json({ error: "No organization role resolved for this request." });
      return;
    }

    const action = resolveAction(req);
    if (!action) {
      res.status(405).json({ error: `Method ${req.method} is not supported here.` });
      return;
    }

    try {
      const permissions = await getPermissions();
      if (!permissions.has(permKey(role, resource, action))) {
        res.status(403).json({
          error: `Access denied: role '${role}' cannot ${action} ${resource}.`,
        });
        return;
      }
      next();
    } catch (err) {
      req.log.error({ err }, "permission check failed");
      res.status(500).json({ error: "Authorization check failed." });
    }
  };
}
