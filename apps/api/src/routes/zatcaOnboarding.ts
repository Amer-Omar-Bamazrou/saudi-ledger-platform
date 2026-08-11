/**
 * ZATCA onboarding routes (M12.4).
 *
 * Tenant-scoped business route, mounted after `resolveTenant` behind
 * `requirePermission("zatca_onboarding")`. Onboarding mints the credential that
 * signs the tenant's legal invoices, so the matrix restricts it to **admin**:
 * read = all roles (so anyone can see the checklist and expiry), create = admin.
 */
import { Router } from "express";
import { zatcaOnboardingController } from "../controllers/zatcaOnboarding.controller";

const router = Router();

router.get("/", zatcaOnboardingController.status);
router.post("/", zatcaOnboardingController.onboard);

/**
 * Renew before the 5-year PCSID expires. Same authority as onboarding (admin) —
 * it mints the credential that signs legal invoices — and resolves to the
 * `approve` action via the existing activation-suffix override in
 * `requirePermission`, so it is admin-only rather than merely create-level.
 */
router.post("/renew", zatcaOnboardingController.renew);

export default router;
