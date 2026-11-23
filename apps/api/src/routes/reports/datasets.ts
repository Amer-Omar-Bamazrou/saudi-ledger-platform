import { Router } from "express";
import { reportsController } from "../../controllers/reports.controller";

/**
 * 🔴 19B S4 — the report datasets (v4 §4, §14). Behind the `reports` permission like every report (mounted under
 * `/reports`); `decide()` then decides the dataset and the act (run, export) for this role, and which columns it sees.
 */
const router = Router();
router.get("/", reportsController.datasets);
router.get("/journal_lines/rows", reportsController.journalLinesRows);
router.get("/journal_lines/export", reportsController.journalLinesExport);
export default router;
