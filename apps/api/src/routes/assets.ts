import { Router } from "express";
import { assetsController } from "../controllers/assets.controller";

const router = Router();

// FA-A (2026-09-22): the register. Capitalisation, the monthly run, estimate
// changes and disposal arrive with their own FA phases — each through
// postJournalEntry after checkPeriodOpen, never a second posting path.
router.get("/", assetsController.list);
router.get("/:id", assetsController.get);
router.post("/", assetsController.create);
router.put("/:id", assetsController.update);
router.post("/:id/cancel", assetsController.cancel);
// FA-B: the acts that move money or the schedule. Capitalisation itself runs
// on the BILL that bought the asset (one writer, one effect).
router.post("/depreciation-runs", assetsController.runPeriod);
router.post("/:id/depreciate", assetsController.depreciate);
router.post("/:id/estimate", assetsController.changeEstimate);
// FA-C: the no-proceeds disposal. A SALE is an invoice that names the asset.
router.post("/:id/dispose", assetsController.dispose);

export default router;
