/** Findings routes (AI-3a) — thin HTTP; authz via requirePermission("findings") at the mount. */
import { Router } from "express";
import { findingsController } from "../controllers/findings.controller";

const router = Router();

router.get("/", findingsController.list);
router.post("/run", findingsController.run);
// POST /:id/acknowledge resolves to the `approve` action (rbac APPROVE_ROUTE).
router.post("/:id/acknowledge", findingsController.acknowledge);

export default router;
