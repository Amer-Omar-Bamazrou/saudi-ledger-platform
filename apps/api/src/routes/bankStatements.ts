import { Router } from "express";
import { bankStatementsController } from "../controllers/bankStatements.controller";

/**
 * Phase 12A — bank statements. There is no create route on purpose: a
 * statement is created by `POST /transactions/upload` with its lines, in one
 * all-or-nothing act, so a statement can never exist without the lines it
 * describes (or lines claim a statement that was never recorded).
 */
const router = Router();

router.get("/", bankStatementsController.list);
router.get("/:id", bankStatementsController.get);

export default router;
