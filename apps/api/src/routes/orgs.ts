/**
 * Organization routes — the user's cross-organization surface.
 *
 * These endpoints are intentionally NOT tenant-scoped: they are mounted BEFORE
 * `resolveTenant` and run on the base connection, because listing and switching
 * organizations is inherently a cross-org operation. Each still requires an
 * authenticated session (mounted after `requireAuth`).
 */
import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, organizationMembershipsTable, organizationsTable } from "@workspace/db";
import { membersService } from "../services/members.service";
import { securityAuditService } from "../services/securityAudit.service";

/** Actor context for the security-audit trail, from the authenticated session. */
function actorCtx(req: { session: { userEmail?: string }; ip?: string }) {
  return { actorEmail: req.session.userEmail ?? null, ipAddress: req.ip ?? null };
}

const router = Router();

/** GET /api/orgs — list the current user's active organization memberships. */
router.get("/", async (req, res) => {
  try {
    const userId = req.session.userId!;
    const organizations = await db
      .select({
        organizationId: organizationsTable.id,
        name: organizationsTable.name,
        slug: organizationsTable.slug,
        role: organizationMembershipsTable.role,
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
      .orderBy(asc(organizationMembershipsTable.createdAt));

    const activeOrgId = req.session.activeOrgId ?? organizations[0]?.organizationId ?? null;
    res.json({ activeOrgId, organizations });
  } catch (err) {
    req.log.error({ err });
    res.status(500).json({ error: "Internal server error" });
  }
});

/** POST /api/orgs/switch { organizationId } — set the active organization. */
router.post("/switch", async (req, res) => {
  try {
    const userId = req.session.userId!;
    const { organizationId } = req.body ?? {};
    if (!organizationId || typeof organizationId !== "string") {
      res.status(400).json({ error: "organizationId is required." });
      return;
    }

    // Verify the user actually belongs to the target organization.
    const [membership] = await db
      .select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable)
      .where(
        and(
          eq(organizationMembershipsTable.userId, userId),
          eq(organizationMembershipsTable.organizationId, organizationId),
          eq(organizationMembershipsTable.status, "active"),
        ),
      )
      .limit(1);

    if (!membership) {
      res.status(403).json({ error: "You are not a member of that organization." });
      return;
    }

    req.session.activeOrgId = organizationId;
    req.session.save((err) => {
      if (err) {
        req.log.error({ err });
        res.status(500).json({ error: "Failed to switch organization." });
        return;
      }
      res.json({ activeOrgId: organizationId });
    });
  } catch (err) {
    req.log.error({ err });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Membership management (M10.6) — provision/administer members of an org.
//
// Thin routes over membersService (logic + explicit authorization live there).
// Mounted here with the org switcher: base (owner) connection, BEFORE
// resolveTenant — `organization_memberships` is global-reference data, so this
// is the identity/infrastructure layer, not the tenant-scoped business layer.
// membersService EXPLICITLY verifies the caller is an admin of the specific
// path org (no ambient context) and, per the M7 boundary, does NOT write these
// security events to the business audit_logs. Thrown AppErrors are mapped by the
// app-level errorHandler (Express 5 forwards async rejections).
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/orgs/:orgId/members — list the org's memberships (admin of that org only). */
router.get("/:orgId/members", async (req, res) => {
  res.json(await membersService.list(req.session.userId!, req.params.orgId));
});

/** POST /api/orgs/:orgId/members { userId, role } — assign/re-activate a member's role. */
router.post("/:orgId/members", async (req, res) => {
  const { userId, role } = req.body ?? {};
  res
    .status(201)
    .json(await membersService.assign(req.session.userId!, req.params.orgId, userId, role, actorCtx(req)));
});

/** PATCH /api/orgs/:orgId/members/:userId { role?, status? } — change a member's role/status. */
router.patch("/:orgId/members/:userId", async (req, res) => {
  const { role, status } = req.body ?? {};
  res.json(
    await membersService.update(
      req.session.userId!,
      req.params.orgId,
      Number(req.params.userId),
      { role, status },
      actorCtx(req),
    ),
  );
});

/**
 * GET /api/orgs/:orgId/security-events — the org's identity/security trail
 * (admin of that org only). Membership changes and other org-scoped security
 * events; global (org-less) events are surfaced by the platform-operator surface
 * in a later milestone, not here.
 */
router.get("/:orgId/security-events", async (req, res) => {
  res.json({ events: await securityAuditService.listForOrg(req.session.userId!, req.params.orgId) });
});

export default router;
