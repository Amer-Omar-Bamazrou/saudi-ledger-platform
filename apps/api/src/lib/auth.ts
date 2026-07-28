/**
 * Auth middleware — requireAuth and requireRole guards.
 * Also exports session type augmentation so TypeScript knows req.session.userId etc.
 */
import type { Request, Response, NextFunction } from "express";

export type UserRole = "admin" | "accountant" | "viewer";

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

/** Requires the user to have one of the given roles. Call after requireAuth. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.session?.userRole as UserRole | undefined;
    if (!role || !roles.includes(role)) {
      res.status(403).json({
        error: `Access denied. Required role: ${roles.join(" or ")}. Your role: ${role ?? "none"}.`,
      });
      return;
    }
    next();
  };
}

/** Shorthand guards */
export const requireAdmin = requireRole("admin");
export const requireAccountantOrAbove = requireRole("admin", "accountant");

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
