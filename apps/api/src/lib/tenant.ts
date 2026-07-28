/**
 * resolveTenant — the linchpin middleware that binds a request to one tenant.
 *
 * Runs after `requireAuth`. For the authenticated user it:
 *   1. loads the user's active organization memberships (a cross-org read, done
 *      on the base/owner connection before any tenant scoping),
 *   2. picks the active organization from the session (set by the org switcher),
 *      defaulting to the user's first/primary membership,
 *   3. resolves that organization's primary company for `company_id` scoping,
 *   4. opens a per-request database transaction that drops to the non-owner DB
 *      role and sets `app.current_org_id` / `app.current_company_id` so Postgres
 *      RLS enforces isolation for every query the request makes, and
 *   5. attaches an immutable `TenantContext` to `req` for downstream handlers.
 *
 * The transaction is committed when the response finishes successfully and rolled
 * back on error/abort, so tenant context can never leak across pooled connections.
 */
import type { Request, Response, NextFunction } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  beginTenantConnection,
  organizationMembershipsTable,
  companiesTable,
} from "@workspace/db";
import { loadEnv } from "@workspace/config";
import type { UserRole } from "./auth";

export interface TenantContext {
  userId: number;
  organizationId: string;
  /** The active organization's primary company, if it has one. */
  companyId: string | null;
  /** The user's role within the active organization (from the membership). */
  role: UserRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

export async function resolveTenant(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.session.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required. Please log in." });
      return;
    }

    // (1) Active memberships — cross-org read on the base connection.
    const memberships = await db
      .select({
        organizationId: organizationMembershipsTable.organizationId,
        role: organizationMembershipsTable.role,
      })
      .from(organizationMembershipsTable)
      .where(
        and(
          eq(organizationMembershipsTable.userId, userId),
          eq(organizationMembershipsTable.status, "active"),
        ),
      )
      .orderBy(asc(organizationMembershipsTable.createdAt));

    if (memberships.length === 0) {
      res.status(403).json({ error: "You are not a member of any organization." });
      return;
    }

    // (2) Active org: honor the session's choice if still a valid membership,
    //     otherwise default to the primary (first) membership.
    const requested = req.session.activeOrgId;
    const active =
      memberships.find((m) => m.organizationId === requested) ?? memberships[0]!;
    if (req.session.activeOrgId !== active.organizationId) {
      req.session.activeOrgId = active.organizationId;
    }

    // (3) Primary company for the active org (first created), for company scoping.
    const [company] = await db
      .select({ id: companiesTable.id })
      .from(companiesTable)
      .where(eq(companiesTable.organizationId, active.organizationId))
      .orderBy(asc(companiesTable.createdAt))
      .limit(1);

    const tenant: TenantContext = {
      userId,
      organizationId: active.organizationId,
      companyId: company?.id ?? null,
      role: active.role as UserRole,
    };
    req.tenant = tenant;

    // (4) Open the RLS-scoped transaction for the rest of the request.
    const { DB_APP_ROLE } = loadEnv();
    const conn = await beginTenantConnection({
      organizationId: tenant.organizationId,
      companyId: tenant.companyId,
      role: DB_APP_ROLE,
    });

    // Commit on success, roll back on error/abort. Guarded so it runs once.
    let settled = false;
    const finalize = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      (commit ? conn.commit() : conn.rollback()).catch((err) =>
        req.log.error({ err }, "tenant transaction finalize failed"),
      );
    };
    res.on("finish", () => finalize(res.statusCode < 400));
    res.on("close", () => finalize(false));

    // (5) Run the remaining handlers with the tenant-scoped db bound.
    conn.run(() => next());
  } catch (err) {
    req.log.error({ err }, "resolveTenant failed");
    res.status(500).json({ error: "Failed to resolve tenant context." });
  }
}
