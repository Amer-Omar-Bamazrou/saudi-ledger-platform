import { Router } from "express";
import { recognitionSchedulesController } from "../controllers/recognitionSchedules.controller";

const router = Router();

// Phase 11 A2/A3 — accruals and prepayments. "/runs" is declared BEFORE "/:id",
// or Express reads "runs" as a schedule id and the month-end run is unreachable.
router.post("/runs", recognitionSchedulesController.run);
router.get("/", recognitionSchedulesController.list);
router.post("/", recognitionSchedulesController.create);
router.get("/:id", recognitionSchedulesController.get);
router.post("/:id/activate", recognitionSchedulesController.activate);
router.post("/:id/recognise", recognitionSchedulesController.recognise);
router.post("/:id/cancel", recognitionSchedulesController.cancel);

export default router;
