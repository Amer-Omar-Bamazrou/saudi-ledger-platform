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
// 🔴 The OWNER connection, named deliberately rather than inherited.
// TENANT RESOLUTION runs BEFORE the tenant scope exists — it is what decides
// which scope to open — so by definition it cannot use the scoped handle. That
// was always true and was previously expressed by the proxy silently falling
// back; it is now stated.
import {
  ownerDb as db,
  beginTenantConnection,
  organizationMembershipsTable,
  organizationsTable,
  companiesTable,
} from "@workspace/db";
import { loadEnv } from "@workspace/config";
import { auditContext } from "./auditContext";
import { selectActiveMembership } from "./activeOrg";
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

    // (1) Active memberships — cross-org read on the base connection. Joined to
    //     organizations so we also have each org's verification status for the gate.
    const memberships = await db
      .select({
        organizationId: organizationMembershipsTable.organizationId,
        role: organizationMembershipsTable.role,
        verificationStatus: organizationsTable.verificationStatus,
        verificationReason: organizationsTable.verificationReason,
      })
      .from(organizationMembershipsTable)
      .innerJoin(
        organizationsTable,
        eq(organizationsTable.id, organizationMembershipsTable.organizationId),
      )
      .where(
        and(
          eq(organizationMembershipsTable.userId, userId),
          eq(organizationMembershipsTable.status, "active"),
        ),
      )
      // L-3 (closed 2026-08-24): `createdAt` alone is a non-deterministic
      // primary when two memberships share a timestamp (bulk invites) — the
      // id is the total order that makes "first membership" one answer.
      .orderBy(asc(organizationMembershipsTable.createdAt), asc(organizationMembershipsTable.id));

    if (memberships.length === 0) {
      res.status(403).json({ error: "You are not a member of any organization." });
      return;
    }

    // (2) Active org: honor the session's choice if still a valid membership,
    //     otherwise default to the primary (first) membership.
    // M18.4.1 — the selection rule is shared with `/orgs` and `/auth/me` (see
    // lib/activeOrg.ts). It used to be written here and again in /orgs, and the
    // two disagreed once the session's choice was no longer a live membership.
    const active = selectActiveMembership(memberships, req.session.activeOrgId)!;
    if (req.session.activeOrgId !== active.organizationId) {
      req.session.activeOrgId = active.organizationId;
    }

    // (2.5) VERIFICATION GATE — a non-`approved` org has NO platform access.
    //   This short-circuits BEFORE beginTenantConnection, so the tenant GUCs
    //   (app.current_org_id / app.current_company_id) are never set and no
    //   org-stamped RLS connection is ever opened. That is the DB-level backstop:
    //   even if a business route were somehow reached without this 403, there is
    //   no tenant context, so RLS matches zero rows (reads) and the NOT NULL
    //   organization_id default (NULL) rejects every write. Because every business
    //   route is mounted AFTER resolveTenant, this gate is fail-closed by
    //   construction for current AND future routes. The body carries {status,
    //   reason} so the web app can route the user to the verification status page.
    if (active.verificationStatus !== "approved") {
      res.status(403).json({
        error: "Your organization is pending verification and cannot use the platform yet.",
        code: "org_not_verified",
        status: active.verificationStatus,
        reason: active.verificationReason ?? null,
      });
      return;
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

    // (5) Run the remaining handlers with the tenant-scoped db AND the audit
    //     context (actor/org/IP) bound for the rest of the request.
    conn.run(() =>
      auditContext.run(
        { userId: tenant.userId, organizationId: tenant.organizationId, ipAddress: req.ip ?? null },
        () => next(),
      ),
    );
  } catch (err) {
    req.log.error({ err }, "resolveTenant failed");
    res.status(500).json({ error: "Failed to resolve tenant context." });
  }
}
