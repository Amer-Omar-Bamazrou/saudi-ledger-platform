import { Router } from "express";
import { assetsController } from "../controllers/assets.controller";

const router = Router();

// FA-A (2026-09-22): the register. Capitalisation, the monthly run, estimate
// changes and disposal arrive with their own FA phases — each through
// postJournalEntry after checkPeriodOpen, never a second posting path.
// FA-E: the Art. 17 pool. Declared BEFORE "/:id", or Express reads
// "income-tax-pool" as an asset id and the route is unreachable.
router.get("/income-tax-pool", assetsController.incomeTaxPool);
router.get("/income-tax-pool/declarations", assetsController.listPoolDeclarations);
router.post("/income-tax-pool/declarations", assetsController.declarePool);
router.delete("/income-tax-pool/declarations/:id", assetsController.deletePoolDeclaration);
// FA-F: the Art. 52 adjustment — also before "/:id".
router.get("/vat-adjustments", assetsController.vatAdjustments);
router.get("/vat-adjustments/use-records", assetsController.listVatUseRecords);
router.post("/vat-adjustments/use-records", assetsController.declareVatUse);
router.delete("/vat-adjustments/use-records/:id", assetsController.deleteVatUseRecord);

router.get("/", assetsController.list);
router.get("/:id", assetsController.get);
router.post("/", assetsController.create);
router.put("/:id", assetsController.update);
router.post("/:id/cancel", assetsController.cancel);
// FA-B: the acts that move money or the schedule. Capitalisation itself runs
// on the BILL that bought the asset (one writer, one effect).
router.post("/depreciation-runs", assetsController.runPeriod);
router.post("/:id/depreciate", assetsController.depreciate);
router.post("/:id/estimate", assetsController.changeEstimate);
// FA-C: the no-proceeds disposal. A SALE is an invoice that names the asset.
router.post("/:id/dispose", assetsController.dispose);

export default router;
