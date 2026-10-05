import { Router } from "express";
import { treasuryController } from "../controllers/treasury.controller";
import { requirePermission } from "../lib/rbac";

/**
 * Phase 17 — Treasury (docs/product/phase-16-17-tax-treasury-decision-pack.md §8).
 * Mounted behind `requirePermission("treasury")`: GET → read; POST → create
 * (a plan, an assumption); PATCH → update; DELETE → delete (admin-only — a plan
 * not yet approved, an assumption); POST …/approve, …/pay (paying a plan
 * through the bill pay path) and …/reject (cancelling a plan) → `approve`.
 *
 * The minimum-balance policy is `/settings`, guarded INSIDE this router by its
 * own, stricter resource `treasury_settings` (GET → read; PUT → update, an
 * approver's) — both guards must pass. It is nested here rather than mounted
 * as a second `/treasury/settings` prefix in routes/index.ts: two nested
 * mounts make mount ORDER decide which guard a request meets, the position
 * hazard the privilege surface map exists to catch.
 */
const router = Router();

const settings = Router();
settings.get("/", treasuryController.settings);
settings.put("/", treasuryController.updateSettings);
router.use("/settings", requirePermission("treasury_settings"), settings);

router.get("/dashboard", treasuryController.dashboard);
router.get("/position", treasuryController.position);
router.get("/forecast", treasuryController.forecast);

router.get("/payment-plans", treasuryController.plans);
router.post("/payment-plans", treasuryController.createPlan);
router.patch("/payment-plans/:id", treasuryController.updatePlan);
router.delete("/payment-plans/:id", treasuryController.removePlan);
router.post("/payment-plans/:id/approve", treasuryController.approvePlan);
router.post("/payment-plans/:id/pay", treasuryController.payPlan);
router.post("/payment-plans/:id/reject", treasuryController.cancelPlan);

router.get("/assumptions", treasuryController.assumptions);
router.post("/assumptions", treasuryController.createAssumption);
router.patch("/assumptions/:id", treasuryController.updateAssumption);
router.delete("/assumptions/:id", treasuryController.removeAssumption);

export default router;
