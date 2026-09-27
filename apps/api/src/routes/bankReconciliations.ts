import { Router } from "express";
import { bankReconciliationsController } from "../controllers/bankReconciliations.controller";

/**
 * Phase 12D — bank reconciliation as of a date. `/position` and `/exceptions`
 * are declared before `/:id` so neither word is read as an id. Recording and
 * reopening write; nothing here posts.
 */
const router = Router();

router.get("/", bankReconciliationsController.list);
router.post("/", bankReconciliationsController.complete);
router.get("/position", bankReconciliationsController.position);
router.get("/exceptions", bankReconciliationsController.exceptions);
router.get("/:id", bankReconciliationsController.get);
router.post("/:id/reopen", bankReconciliationsController.reopen);

export default router;
