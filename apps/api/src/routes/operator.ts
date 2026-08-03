/**
 * Platform-operator routes (M11.3) — the verification review surface.
 *
 * Mounted BEFORE resolveTenant and guarded by requirePlatformOperator (see
 * routes/index.ts): base connection, cross-tenant, operator-only. Every endpoint
 * returns or mutates ONLY verification metadata — never a tenant's financial
 * data. Thin routes over operatorService (logic + audit + history live there);
 * thrown AppErrors are mapped by the app-level errorHandler.
 */
import { Router } from "express";
import { operatorService } from "../services/operator.service";

const router = Router();

/** Actor context for the security-audit trail, from the authenticated session. */
function actorCtx(req: { session: { userEmail?: string }; ip?: string }) {
  return { actorEmail: req.session.userEmail ?? null, ipAddress: req.ip ?? null };
}

/** GET /api/operator/applications — the review queue (all non-approved orgs). */
router.get("/applications", async (_req, res) => {
  res.json(await operatorService.listApplications());
});

/** GET /api/operator/applications/:orgId — one application's review detail (audited). */
router.get("/applications/:orgId", async (req, res) => {
  res.json(await operatorService.getApplication(req.session.userId!, req.params.orgId, actorCtx(req)));
});

/** POST /api/operator/applications/:orgId/approve — grant the org full access. */
router.post("/applications/:orgId/approve", async (req, res) => {
  res.json(await operatorService.approve(req.session.userId!, req.params.orgId, actorCtx(req)));
});

/** POST /api/operator/applications/:orgId/reject { reason } — terminal reject. */
router.post("/applications/:orgId/reject", async (req, res) => {
  res.json(await operatorService.reject(req.session.userId!, req.params.orgId, req.body?.reason, actorCtx(req)));
});

/** POST /api/operator/applications/:orgId/request-info { reason } — return for more info. */
router.post("/applications/:orgId/request-info", async (req, res) => {
  res.json(await operatorService.requestInfo(req.session.userId!, req.params.orgId, req.body?.reason, actorCtx(req)));
});

/** POST /api/operator/applications/:orgId/reopen { reason } — rejected → needs_info (mistake fix). */
router.post("/applications/:orgId/reopen", async (req, res) => {
  res.json(await operatorService.reopen(req.session.userId!, req.params.orgId, req.body?.reason, actorCtx(req)));
});

export default router;
