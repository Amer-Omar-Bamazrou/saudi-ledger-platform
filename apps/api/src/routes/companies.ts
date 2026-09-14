/**
 * Company settings routes (M11.6) — the active company's legal identity.
 *
 * Tenant-scoped business route: mounted after `resolveTenant` behind
 * `requirePermission("companies")`, so RLS confines it to the active org and the
 * seeded matrix decides who may write (read = all roles, update = admin only —
 * the VAT/CR numbers feed the ZATCA QR and invoice hash chain).
 */
import { Router } from "express";
import multer from "multer";
import { companiesController } from "../controllers/companies.controller";
import { uploadSingle } from "./documentHttp";
import { MAX_LOGO_BYTES } from "../lib/fileValidation";

const router = Router();

// L1 branding — one small file; multer's limit is the belt, validateLogoBytes
// the named 400.
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES } });

// M17.2 — declared BEFORE `/current` so Express does not treat "fiscal-years"
// as part of a looser match later; both are literal paths today, but the
// ordering keeps that true if `/current/:section` is ever added.
router.get("/current/fiscal-years", companiesController.fiscalYears);
router.get("/current/logo", companiesController.getLogo);
router.put("/current/logo", uploadSingle(logoUpload, "file"), companiesController.uploadLogo);
router.delete("/current/logo", companiesController.removeLogo);
router.get("/current", companiesController.getCurrent);
router.patch("/current", companiesController.updateCurrent);

export default router;
