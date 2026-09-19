import { Router } from "express";
import { migrationController } from "../controllers/migration.controller";

/**
 * Batch 1C (2026-09-18) — migration of an existing business. Admin-only by
 * the permission matrix (`migration`: every action ADMIN_ONLY; read admin +
 * accountant). Nothing here posts before `commit` (a later phase); the chart
 * and staging endpoints only ever write staging rows of a draft batch.
 */
const router = Router();

router.get("/batches", migrationController.list);
router.post("/batches", migrationController.create);
router.get("/batches/:id", migrationController.get);
router.post("/batches/:id/discard", migrationController.discard);
router.get("/batches/:id/chart", migrationController.getChart);
router.put("/batches/:id/chart", migrationController.importChart);
router.patch("/batches/:id/chart/:rowId", migrationController.decideChartRow);

// Phase 2 — parties, open items, advances, the opening position, validation (zero ledger writes).
router.patch("/batches/:id", migrationController.update);
router.get("/batches/:id/parties", migrationController.getParties);
router.put("/batches/:id/parties", migrationController.importParties);
router.patch("/batches/:id/parties/:rowId", migrationController.decideParty);
router.get("/batches/:id/open-items", migrationController.getOpenItems);
router.put("/batches/:id/open-items", migrationController.importOpenItems);
router.get("/batches/:id/advances", migrationController.getAdvances);
router.put("/batches/:id/advances", migrationController.importAdvances);
router.get("/batches/:id/opening-position", migrationController.openingPosition);
router.post("/batches/:id/validate", migrationController.validate);

// Phase 3 — the commit (one transaction, R1–R10 as gates), the accountant's
// OBE clearing journal, and the reversal. All admin-only writes.
router.post("/batches/:id/commit", migrationController.commit);
router.post("/batches/:id/clear-obe", migrationController.clearObe);
router.get("/batches/:id/reversal-preview", migrationController.reversalPreview);
router.post("/batches/:id/reverse", migrationController.reverse);

export default router;
