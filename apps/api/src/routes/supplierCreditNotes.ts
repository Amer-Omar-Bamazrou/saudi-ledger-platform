import { Router } from "express";
import { supplierCreditNotesController } from "../controllers/supplierStatements.controller";

/**
 * B7 (2026-09-22) — purchase-side notes AFTER they are in the books.
 *
 * 🔴 There is no create route here on purpose. A purchase note is a `bills`
 * row: it is entered through `POST /bills` with `documentType` (guarded at
 * that write boundary by `assertPurchaseNote`) and approved through
 * `POST /bills/:id/approve`, which posts it MIRRORED. A second creation path
 * for the same row is what this codebase refuses.
 */
const router = Router();

router.get("/", supplierCreditNotesController.list);
router.get("/:id", supplierCreditNotesController.get);
router.post("/:id/apply", supplierCreditNotesController.apply);

export default router;
