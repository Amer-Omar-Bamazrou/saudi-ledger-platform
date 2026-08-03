/**
 * Auth middleware — requireAuth and requireRole guards.
 * Also exports session type augmentation so TypeScript knows req.session.userId etc.
 */
import type { Request, Response, NextFunction } from "express";

export type UserRole = "admin" | "accountant" | "bookkeeper" | "viewer";

declare module "express-session" {
  interface SessionData {
    userId: number;
    userRole: UserRole;
    userName: string;
    userEmail: string;
    /** The organization the user is currently acting in (set by the org switcher). */
    activeOrgId: string;
  }
}

/** Requires a valid session. Returns 401 if not authenticated. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Authentication required. Please log in." });
    return;
  }
  next();
}

/**
 * REMOVED in M11.5.1 (security hotfix): `requireRole` / `requireAdmin` /
 * `requireAccountantOrAbove`.
 *
 * These authorized off the ambient GLOBAL `req.session.userRole` (derived from
 * the vestigial `users.role` column) with no tenant scoping. They guarded the
 * `/auth` user-administration surface, which meant:
 *   - once the public M11.5 signup made `users.role = "admin"` self-grantable,
 *     ANY anonymous caller could reach those endpoints; and
 *   - even for a legitimate admin the endpoints were cross-tenant (an admin of
 *     org A could enumerate and reset the password of org B's users).
 *
 * They are deleted rather than deprecated so the pattern cannot be reintroduced
 * by autocomplete. Authorize instead with one of:
 *   - `requirePermission(resource)`      — tenant-scoped business routes (M5),
 *                                          reads `req.tenant.role`;
 *   - explicit admin-of-THAT-org checks  — identity layer (M10.6 members,
 *                                          M11.5.1 userAdmin.service);
 *   - `requirePlatformOperator`          — cross-tenant operator surface (M11.3).
 */

/**
 * Like {@link requireRole} but reads the role from the resolved tenant context
 * (the active organization membership) rather than the session. Must run after
 * `resolveTenant`. This is the tenant-scoped authorization seam for business
 * routes; global user-management still uses the session-based guards above.
 */
export function requireTenantRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.tenant?.role;
    if (!role || !roles.includes(role)) {
      res.status(403).json({
        error: `Access denied. Required role: ${roles.join(" or ")}. Your role: ${role ?? "none"}.`,
      });
      return;
    }
    next();
  };
}
