import { Router } from "express";
import { bankReconciliationController } from "../controllers/bankReconciliation.controller";

/**
 * Phase 12B — reconciling bank statement lines to the ledger. Identity, never
 * posting: nothing reached from here writes a journal entry.
 * `/ap-matching` and `/links/:id/reverse` are declared before the `:id` routes
 * so neither word is read as a line id.
 */
const router = Router();

router.get("/ap-matching", bankReconciliationController.classifyAp);
router.post("/ap-matching/apply", bankReconciliationController.applyAp);
router.post("/links/:id/reverse", bankReconciliationController.unlink);
router.get("/lines", bankReconciliationController.lines);
router.get("/lines/:id", bankReconciliationController.line);
router.post("/lines/:id/links", bankReconciliationController.link);

export default router;
