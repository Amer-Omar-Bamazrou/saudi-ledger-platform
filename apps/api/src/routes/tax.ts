import { Router } from "express";
import { taxController } from "../controllers/tax.controller";

/**
 * Phase 16 — Saudi tax (docs/product/phase-16-17-tax-treasury-decision-pack.md).
 * Mounted behind `requirePermission("tax")`: GET → read; POST → create
 * (drafts, adjustments, classifications, a pending relief); PUT/PATCH →
 * update; DELETE → delete (admin); and POST …/pay (a WHT remittance),
 * …/reverse (its reversal), …/approve, …/send-back, …/reject → `approve`
 * (rbac.ts APPROVE_ROUTE) — the approver's acts, by construction of the path.
 */
const router = Router();

router.get("/obligations", taxController.obligations);

router.get("/wht/rates", taxController.rates);
router.get("/wht/preview", taxController.preview);
router.get("/wht/overview", taxController.overview);
router.get("/wht/returns/:period", taxController.monthlyReturn);
router.get("/wht/annual", taxController.annual);
router.get("/wht/beneficiaries/:vendorId", taxController.beneficiary);
router.get("/wht/exceptions", taxController.exceptions);
router.post("/wht/periods/:period/pay", taxController.remit);
router.post("/wht/remittances/:id/reverse", taxController.reverseRemittance);
router.get("/wht/reliefs", taxController.reliefs);
router.post("/wht/reliefs", taxController.createRelief);
router.delete("/wht/reliefs/:id", taxController.removeRelief);
router.post("/wht/reliefs/:id/approve", taxController.approveRelief);
router.post("/wht/reliefs/:id/reject", taxController.revokeRelief);

router.get("/zakat/classifications", taxController.classifications);
router.put("/zakat/classifications/:accountId", taxController.setClassification);
router.post("/zakat/classifications/:accountId/clear", taxController.clearClassification);

router.get("/computations", taxController.list);
router.post("/computations", taxController.create);
router.get("/computations/:id", taxController.get);
router.patch("/computations/:id", taxController.update);
router.delete("/computations/:id", taxController.remove);
router.post("/computations/:id/versions", taxController.revise);
router.post("/computations/:id/versions/:versionId/adjustments", taxController.addAdjustment);
router.patch("/computations/:id/versions/:versionId/adjustments/:adjustmentId", taxController.updateAdjustment);
router.post("/computations/:id/versions/:versionId/adjustments/:adjustmentId/remove", taxController.removeAdjustment);
router.put("/computations/:id/versions/:versionId/losses", taxController.setLosses);
router.post("/computations/:id/versions/:versionId/submit", taxController.submit);
router.post("/computations/:id/versions/:versionId/approve", taxController.approve);
router.post("/computations/:id/versions/:versionId/send-back", taxController.sendBack);
router.post("/computations/:id/versions/:versionId/reject", taxController.reject);

export default router;
