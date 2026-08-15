/**
 * Finance Hub routes (M18.3) — the control surface's read model.
 *
 * Read-only and derived: every figure comes from the general ledger via
 * `reports.balanceSheet`, and the review count is mirrored from the Banking
 * review surface rather than recomputed (design Q7). Nothing here writes.
 */
import { Router } from "express";
import { financeHubController } from "../controllers/financeHub.controller";

const router = Router();

router.get("/liquidity", financeHubController.liquidity);
router.get("/tax-compliance", financeHubController.taxCompliance);
router.get("/books-status", financeHubController.booksStatus);

export default router;
