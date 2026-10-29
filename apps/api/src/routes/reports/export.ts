import { Router } from "express";
import { reportsController } from "../../controllers/reports.controller";
import { requireReadOf } from "../../lib/rbac";
import { exportNativeResource } from "../../services/reporting/reportExport.service";

/**
 * Phase 14 (D14-10) — `GET /reports/export/:report?format=csv|pdf&lang=en|ar&<the report's own params>`.
 * Behind the same `reports` permission as every report screen (mounted under
 * `/reports` in routes/index.ts), inside the same tenant + company transaction.
 *
 * 🔴 Phase 18 H-10 (DR-26; register §11.58): AND behind read on the report's
 * NATIVE resource (`EXPORT_NATIVE_RESOURCE`): the WHT return's export needs
 * `tax`, as its screen does. Every export produced is audited (the service).
 */
const router = Router();
router.get("/:report", requireReadOf((req) => exportNativeResource(String(req.params.report))), reportsController.export);
export default router;
