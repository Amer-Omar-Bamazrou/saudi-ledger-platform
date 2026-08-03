/**
 * Onboarding routes (M11.2/M11.4) — the surface a not-yet-approved organization
 * can still reach.
 *
 * Mounted BEFORE `resolveTenant` (identity/infrastructure layer, base
 * connection), so it is NOT subject to the verification gate — a pending /
 * needs_info / rejected org must be able to see its status AND upload/resubmit
 * documents. Each endpoint requires an authenticated session (mounted after
 * `requireAuth`) and authorizes by membership (the service resolves the caller's
 * active org). Thrown AppErrors are mapped by the app-level errorHandler.
 */
import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { onboardingService } from "../services/onboarding.service";
import { documentsService } from "../services/documents.service";
import { MAX_DOCUMENT_BYTES } from "../lib/fileValidation";
import { sendDocument, uploadSingle } from "./documentHttp";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES }, // re-validated in the service from the actual bytes
});

/**
 * Document upload is reachable by NOT-yet-approved organizations by design (the
 * onboarding router is mounted before the verification gate so applicants can
 * submit evidence). That makes it an abuse surface for anyone who can sign up:
 * multer buffers each file in PROCESS MEMORY, so unbounded concurrent uploads are
 * a memory/storage-cost DoS. Throttle per IP; a per-org quota is additionally
 * enforced in documentsService.upload.
 */
const uploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many document uploads. Please try again later." },
});

function actorCtx(req: { session: { userEmail?: string }; ip?: string }) {
  return { actorEmail: req.session.userEmail ?? null, ipAddress: req.ip ?? null };
}

/** GET /api/onboarding/status — the active org's verification status + reason. */
router.get("/status", async (req, res) => {
  res.json(await onboardingService.getStatus(req.session.userId!, req.session.activeOrgId));
});

/** POST /api/onboarding/documents (multipart: file, type) — upload a verification doc. */
router.post("/documents", uploadRateLimiter, uploadSingle(upload, "file"), async (req, res) => {
  const orgId = await onboardingService.requireActiveOrgId(req.session.userId!, req.session.activeOrgId);
  const file = req.file ? { buffer: req.file.buffer, originalName: req.file.originalname } : undefined;
  res.status(201).json(await documentsService.upload(req.session.userId!, orgId, req.body?.type, file, actorCtx(req)));
});

/** POST /api/onboarding/resubmit — needs_info → pending_review after supplying info. */
router.post("/resubmit", async (req, res) => {
  res.json(await onboardingService.resubmit(req.session.userId!, req.session.activeOrgId, actorCtx(req)));
});

/** GET /api/onboarding/documents — list the active org's uploaded documents. */
router.get("/documents", async (req, res) => {
  const orgId = await onboardingService.requireActiveOrgId(req.session.userId!, req.session.activeOrgId);
  res.json(await documentsService.listForOrg(orgId));
});

/** GET /api/onboarding/documents/:docId — download one of the active org's own docs. */
router.get("/documents/:docId", async (req, res) => {
  const orgId = await onboardingService.requireActiveOrgId(req.session.userId!, req.session.activeOrgId);
  sendDocument(res, await documentsService.download(orgId, req.params.docId));
});

export default router;
