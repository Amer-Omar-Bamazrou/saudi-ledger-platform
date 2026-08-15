import { Router } from "express";
import { summaryController } from "../controllers/summary.controller";

const router = Router();

router.get("/", summaryController.summary);
router.get("/vat", summaryController.vat);
// `GET /summary/zakat` was REMOVED in M17.0 — it summed rows flagged
// `is_zakat_relevant`, which only one categorization rule (Tadawul/investment)
// ever set, so it returned a computed-looking SAR 0.00 for almost every tenant
// and a wrong non-zero figure for the rest. Zakat returns in M17.4 as a
// GL-derived working paper under Tax & Compliance, not as a summary endpoint.
router.get("/by-category", summaryController.byCategory);

export default router;
