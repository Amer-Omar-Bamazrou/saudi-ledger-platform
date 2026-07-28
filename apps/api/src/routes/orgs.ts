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

export default router;
