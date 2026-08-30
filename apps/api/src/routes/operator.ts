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
import { operatorZatcaService } from "../services/operatorZatca.service";
import { documentsService } from "../services/documents.service";
import { sendDocument } from "./documentHttp";
import { BadRequestError } from "../lib/errors";
import { isOperatorRunnable, operatorRunnableJobNames } from "../lib/operatorJobs";
import { securityAuditService } from "../services/securityAudit.service";

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

/** GET /api/operator/applications/:orgId/documents/:docId — download a document (audited). */
router.get("/applications/:orgId/documents/:docId", async (req, res) => {
  const doc = await documentsService.operatorView(
    req.session.userId!,
    req.params.orgId,
    req.params.docId,
    actorCtx(req),
  );
  sendDocument(res, doc);
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

// ── ZATCA e-invoicing visibility (M12.8) ───────────────────────────────────
// Operational metadata only — queue depth, ages, certificate expiry, onboarding
// state. Never a tenant's financial data, never XML, never key material.

/** GET /api/operator/zatca/health — the outbox age alarm + archive coverage. */
router.get("/zatca/health", async (_req, res) => {
  res.json(await operatorZatcaService.health());
});

/** GET /api/operator/zatca/overdue — documents past the overdue threshold. */
router.get("/zatca/overdue", async (_req, res) => {
  res.json(await operatorZatcaService.overdue());
});

/** GET /api/operator/zatca/needs-review — documents a human must reconcile. */
router.get("/zatca/needs-review", async (_req, res) => {
  res.json(await operatorZatcaService.needsReview());
});

/** GET /api/operator/zatca/certificates?days=90 — expiring PCSIDs + reminder state. */
router.get("/zatca/certificates", async (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 90;
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    throw new BadRequestError("days must be between 1 and 3650");
  }
  res.json(await operatorZatcaService.expiringCertificates(days));
});

/** GET /api/operator/zatca/onboarding — per-company onboarding state (from the vault). */
router.get("/zatca/onboarding", async (_req, res) => {
  const { limit, offset } = _req.query as Record<string, string>;
  const n = Number(limit);
  res.json(
    await operatorZatcaService.onboardingStatus({
      limit: Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined,
      offset: Math.max(0, Number(offset) || 0),
    }),
  );
});

/**
 * POST /api/operator/zatca/jobs/:name/run — run one background job now.
 *
 * The jobs are deliberately runnable with `ZATCA_WORKER_ENABLED` off, so an
 * operator can drain the outbox, sweep the archive or re-check expiry without
 * enabling the polling loop.
 *
 * 🔴 F2: the allowlist is `lib/operatorJobs.ts`, NOT the scheduler registry.
 * This route used to validate against every registered job, so the operator
 * surface silently gained reach each time any milestone added one — nine
 * permitted against the three this comment names and the three the UI offers.
 * A registration is not an authorization; see that file for the classification.
 *
 * The run is AUDITED. It was the only operator route that recorded nothing —
 * every other one, including a mere view, writes a security event — while being
 * the most consequential thing an operator can do (draining the outbox
 * transmits tenants' invoices to a tax authority).
 */
router.post("/zatca/jobs/:name/run", async (req, res) => {
  const name = req.params.name;
  if (!isOperatorRunnable(name)) {
    // One answer for "no such job" and "not yours to run": the set of
    // registered-but-forbidden job names is not an operator's business, and a
    // distinct message would enumerate the platform's internals.
    throw new BadRequestError(
      `Unknown job '${name}'. Runnable jobs: ${operatorRunnableJobNames().join(", ")}`,
    );
  }
  const result = await operatorZatcaService.runJob(name);
  await securityAuditService.record({
    action: "operator.job_run",
    actorUserId: req.session.userId!,
    actorEmail: req.session.userEmail ?? null,
    // Deliberately org-less: a job run is platform-wide and touches every
    // tenant's queue, so naming one organization would misreport its scope.
    organizationId: null,
    metadata: { job: name },
    ipAddress: req.ip ?? null,
  });
  res.json(result);
});

export default router;
