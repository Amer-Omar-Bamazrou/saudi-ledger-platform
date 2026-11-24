import { Router } from "express";
import { vendorsController } from "../controllers/vendors.controller";
import { supplierAdvanceInvoicesController } from "../controllers/supplierAdvanceInvoices.controller";

const router = Router();

router.get("/", vendorsController.list);
// 19B S2b: before "/:id", which would read "picker" and "field-access" as an id
router.get("/picker", vendorsController.picker);
router.get("/field-access", vendorsController.fieldAccess);
router.get("/:id", vendorsController.get);
router.get("/:id/open-advance-invoices", supplierAdvanceInvoicesController.openForVendor);
router.post("/match", vendorsController.match);
router.post("/", vendorsController.create);
router.patch("/:id", vendorsController.update);
router.delete("/:id", vendorsController.remove);

export default router;
