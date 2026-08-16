/**
 * Analytics routes (M19) — read-only, derived from the ledger.
 *
 * Gated on `reports` like the Finance Hub: every role may read, nothing here
 * writes. Analytics owns the TREND; the hub owns the point-in-time claim
 * (design-analytics.md §3).
 */
import { Router } from "express";
import { analyticsController } from "../controllers/analytics.controller";

const router = Router();

router.get("/trend", analyticsController.trend);
router.get("/decomposition", analyticsController.decomposition);
router.get("/receivables-bridge", analyticsController.receivablesBridge);
router.get("/cash", analyticsController.cash);

export default router;
