/**
 * Onboarding routes (M11.2) — the surface a not-yet-approved organization can
 * still reach.
 *
 * Mounted BEFORE `resolveTenant` (identity/infrastructure layer, base
 * connection), so it is NOT subject to the verification gate — a pending /
 * needs_info / rejected org must be able to see its status (and, from
 * M11.4/M11.5, upload documents and resubmit). Each endpoint still requires an
 * authenticated session (mounted after `requireAuth`) and authorizes by
 * membership in the service layer. Thrown AppErrors are mapped by the app-level
 * errorHandler (Express 5 forwards async rejections).
 */
import { Router } from "express";
import { onboardingService } from "../services/onboarding.service";

const router = Router();

/** GET /api/onboarding/status — the active org's verification status + reason. */
router.get("/status", async (req, res) => {
  res.json(await onboardingService.getStatus(req.session.userId!, req.session.activeOrgId));
});

export default router;
