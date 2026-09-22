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

export default router;
