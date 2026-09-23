import { Router } from "express";
import { supplierStatementsController } from "../controllers/supplierStatements.controller";

/**
 * B5 (2026-09-22) — a supplier's POSITION and the statement it is rebuilt
 * from. Reads only: nothing here posts, and nothing here stores a balance.
 */
const router = Router();

router.get("/", supplierStatementsController.list);
router.get("/:vendorId", supplierStatementsController.statement);

export default router;
