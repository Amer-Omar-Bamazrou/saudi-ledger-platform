import { Router } from "express";
import { budgetsController } from "../controllers/budgets.controller";

/**
 * Phase 15 budgets. Mounted behind `requirePermission("budgets")`, which maps
 * GET → read, POST → create (submit, revise), PUT/PATCH → update, DELETE →
 * delete, and POST …/approve | …/send-back | …/reject → `approve` (rbac.ts
 * APPROVE_ROUTE) — the approver's acts (D15-12).
 */
const router = Router();

router.get("/", budgetsController.list);
router.post("/", budgetsController.create);
// before /:id, so "accounts" is never read as an id
router.get("/accounts", budgetsController.accounts);
router.get("/:id", budgetsController.get);
router.patch("/:id", budgetsController.update);
router.delete("/:id", budgetsController.remove);
router.get("/:id/vs-actual", budgetsController.vsActual);
router.post("/:id/versions", budgetsController.revise);
router.put("/:id/versions/:versionId/lines", budgetsController.replaceLines);
router.post("/:id/versions/:versionId/submit", budgetsController.submit);
router.post("/:id/versions/:versionId/approve", budgetsController.approve);
router.post("/:id/versions/:versionId/send-back", budgetsController.sendBack);
router.post("/:id/versions/:versionId/reject", budgetsController.reject);

export default router;
