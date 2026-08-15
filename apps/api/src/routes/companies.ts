/**
 * Company settings routes (M11.6) — the active company's legal identity.
 *
 * Tenant-scoped business route: mounted after `resolveTenant` behind
 * `requirePermission("companies")`, so RLS confines it to the active org and the
 * seeded matrix decides who may write (read = all roles, update = admin only —
 * the VAT/CR numbers feed the ZATCA QR and invoice hash chain).
 */
import { Router } from "express";
import { companiesController } from "../controllers/companies.controller";

const router = Router();

// M17.2 — declared BEFORE `/current` so Express does not treat "fiscal-years"
// as part of a looser match later; both are literal paths today, but the
// ordering keeps that true if `/current/:section` is ever added.
router.get("/current/fiscal-years", companiesController.fiscalYears);
router.get("/current", companiesController.getCurrent);
router.patch("/current", companiesController.updateCurrent);

export default router;
