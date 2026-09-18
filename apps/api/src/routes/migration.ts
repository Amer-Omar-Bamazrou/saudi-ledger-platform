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

export default router;
