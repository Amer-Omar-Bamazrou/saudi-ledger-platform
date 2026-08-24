/** Findings routes (AI-3a) — thin HTTP; authz via requirePermission("findings") at the mount. */
import { Router } from "express";
import { findingsController } from "../controllers/findings.controller";

const router = Router();

router.get("/", findingsController.list);
// AI-5: cadence + last scheduled run + the derived escalation flag the
// Dashboard marker renders. Read-level: the marker must be visible wherever
// the tenant looks.
router.get("/status", findingsController.status);
router.post("/run", findingsController.run);
// PUT resolves to `update` → approver-level grant (configuring the review
// rhythm is a review decision).
router.put("/schedule", findingsController.setSchedule);
// POST /:id/acknowledge resolves to the `approve` action (rbac APPROVE_ROUTE).
router.post("/:id/acknowledge", findingsController.acknowledge);

export default router;
