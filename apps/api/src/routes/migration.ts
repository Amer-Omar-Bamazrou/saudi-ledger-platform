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

// Phase 3 — the commit (one transaction, R1–R10 as gates) and the reversal.
// All admin-only writes. (There is no clear-obe: an unbalanced position is
// refused before commit — accountant A5, 2026-09-20.)
router.post("/batches/:id/commit", migrationController.commit);
router.get("/batches/:id/reversal-preview", migrationController.reversalPreview);
router.post("/batches/:id/reverse", migrationController.reverse);
// 2026-09-22 (accountant answers 3 and 5): item-level correction of a committed migrated item, and its e-invoicing identity recorded once.
router.get("/batches/:id/assets", migrationController.getAssets);
router.put("/batches/:id/assets", migrationController.importAssets);
router.post("/open-items/:itemId/correct", migrationController.correctOpenItem);
router.put("/open-items/:itemId/identity", migrationController.recordOpenItemIdentity);

export default router;
