/**
 * RBAC — centralized, data-driven authorization for business routes.
 *
 * `requirePermission(resource)` is the single authorization seam. It reads the
 * caller's role from the resolved tenant context (`req.tenant.role`, the active
 * organization-membership role set by `resolveTenant` — never the global
 * `users.role`), infers the action from the HTTP method, and checks the pair
 * against the seeded `permissions` table (role → resource → action).
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

    const action = METHOD_ACTION[req.method];
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
