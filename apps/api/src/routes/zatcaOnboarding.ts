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

export default router;
