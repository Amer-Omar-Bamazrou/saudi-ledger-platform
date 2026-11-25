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
// 19B S5 — the remaining datasets: the same two acts, each through decide().
router.get("/sales_documents/rows", reportsController.datasetRows("sales_documents"));
router.get("/sales_documents/export", reportsController.datasetExport("sales_documents"));
router.get("/purchase_documents/rows", reportsController.datasetRows("purchase_documents"));
router.get("/purchase_documents/export", reportsController.datasetExport("purchase_documents"));
router.get("/cash_movements/rows", reportsController.datasetRows("cash_movements"));
router.get("/cash_movements/export", reportsController.datasetExport("cash_movements"));
router.get("/vat_lines/rows", reportsController.datasetRows("vat_lines"));
router.get("/vat_lines/export", reportsController.datasetExport("vat_lines"));
export default router;
