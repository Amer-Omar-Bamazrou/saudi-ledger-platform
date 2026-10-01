import { Router } from "express";
import { openingVatDeclarationsController } from "../controllers/openingVatDeclarations.controller";

/**
 * Phase 13B S1 — the historical input-VAT position of an OPENING payable,
 * declared once with its evidence. Mounted OUTSIDE `/migration` on purpose:
 * the declaration is granted to the admin AND the accountant (owner decision
 * D4 — a dedicated `opening_vat_declaration` resource), and `migration` write
 * is the admin's alone (batch create / commit / reverse). No update or delete
 * route exists: a declaration is append-only, in the database too (0110).
 */
const router = Router();

router.get("/", openingVatDeclarationsController.list);
router.post("/", openingVatDeclarationsController.declare);

export default router;
