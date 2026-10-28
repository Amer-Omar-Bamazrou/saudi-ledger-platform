import { Router } from "express";
import { taxController } from "../controllers/tax.controller";
import { periodRecordsController } from "../controllers/periodRecords.controller";
import { whtClaimsController } from "../controllers/whtClaims.controller";

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
// 🔴 Phase 18 G4a (owner decision 16): a filed month is corrected in its own statement — what changed since the filing
router.get("/wht/returns/:period/correction-pack", taxController.correctionPack);
router.get("/wht/annual", taxController.annual);
router.get("/wht/beneficiaries/:vendorId", taxController.beneficiary);
router.get("/wht/exceptions", taxController.exceptions);
router.post("/wht/periods/:period/pay", taxController.remit);
// 🔴 T1e (DR-10): filed VAT and Zakat/income-tax returns — recorded and read, never changed.
router.get("/vat-return-filings", periodRecordsController.vatFilings);
router.post("/vat-return-filings", periodRecordsController.recordVatFiling);
// 🔴 Phase 18 G2a (decisions 9–12; A5(a)): errors found in a filed return — recorded and read, never changed;
// the route of each return's corrections; the VAT entries recorded after a filing, dated in its period.
router.get("/vat-return-filings/entries-after-filing", periodRecordsController.entriesAfterFiling);
router.get("/vat-corrections", periodRecordsController.vatCorrections);
router.post("/vat-corrections", periodRecordsController.recordVatCorrection);
router.get("/zakat-income-tax-filings", periodRecordsController.zakatIncomeTaxFilings);
router.post("/zakat-income-tax-filings", periodRecordsController.recordZakatIncomeTaxFiling);
// Q1 (pack §14.1): a month's Form 06 recorded FILED, or amended (`…/file` → approve)
router.post("/wht/returns/:period/file", taxController.fileReturn);
// Q1: one withholding's lineage (original → reversal → corrected), and its correction (`…/reverse` → approve)
router.get("/wht/withholdings/:id", taxController.withholdingLineage);
router.post("/wht/withholdings/:id/reverse", taxController.correctWithholding);
router.post("/wht/remittances/:id/reverse", taxController.reverseRemittance);
// 🔴 Phase 18 G4b (decisions 17, 18): records only — an over-withheld amount's refund claim, and an instalment request
// under Resolution 1117 that counts only once ZATCA's written acceptance is recorded. Append-only; events record their life.
router.get("/wht/refund-claims", whtClaimsController.refundClaims);
router.post("/wht/refund-claims", whtClaimsController.createRefundClaim);
router.post("/wht/refund-claims/:id/events", whtClaimsController.addRefundClaimEvent);
router.get("/wht/instalment-requests", whtClaimsController.instalmentRequests);
router.post("/wht/instalment-requests", whtClaimsController.createInstalmentRequest);
router.post("/wht/instalment-requests/:id/events", whtClaimsController.addInstalmentRequestEvent);
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
