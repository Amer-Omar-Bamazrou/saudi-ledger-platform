import { Router } from "express";
import { summaryController } from "../controllers/summary.controller";

const router = Router();

router.get("/", summaryController.summary);
router.get("/vat", summaryController.vat);
router.get("/zakat", summaryController.zakat);
router.get("/by-category", summaryController.byCategory);

export default router;
