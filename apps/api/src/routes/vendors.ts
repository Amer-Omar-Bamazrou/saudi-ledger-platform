import { Router } from "express";
import { vendorsController } from "../controllers/vendors.controller";
import { supplierAdvanceInvoicesController } from "../controllers/supplierAdvanceInvoices.controller";

const router = Router();

router.get("/", vendorsController.list);
router.get("/:id", vendorsController.get);
router.get("/:id/open-advance-invoices", supplierAdvanceInvoicesController.openForVendor);
router.post("/match", vendorsController.match);
router.post("/", vendorsController.create);
router.patch("/:id", vendorsController.update);
router.delete("/:id", vendorsController.remove);

export default router;
