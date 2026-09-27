import { Router } from "express";
import { bankReconciliationsController } from "../controllers/bankReconciliations.controller";

/** Phase 12D — the cash position per bank (a report: read only). */
const router = Router();
router.get("/", bankReconciliationsController.cashPosition);
export default router;
