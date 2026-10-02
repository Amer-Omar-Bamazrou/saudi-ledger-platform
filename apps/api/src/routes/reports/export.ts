import { Router } from "express";
import { reportsController } from "../../controllers/reports.controller";

/**
 * Phase 14 (D14-10) — `GET /reports/export/:report?format=csv|pdf&lang=en|ar&<the report's own params>`.
 * Behind the same `reports` permission as every report screen (mounted under
 * `/reports` in routes/index.ts), inside the same tenant + company transaction.
 */
const router = Router();
router.get("/:report", reportsController.export);
export default router;
