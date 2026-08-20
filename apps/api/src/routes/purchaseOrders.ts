import { Router } from "express";
import { purchaseOrdersController } from "../controllers/purchaseOrders.controller";

const router = Router();

router.get("/", purchaseOrdersController.list);
router.get("/:id", purchaseOrdersController.get);
router.post("/", purchaseOrdersController.create);

// Approval workflow. approve / send-back / reject resolve to the `approve`
// action via requirePermission's APPROVE_ROUTE override; submit stays
// create-level (the enterer's own action).
router.post("/:id/submit", purchaseOrdersController.submit);
router.post("/:id/send-back", purchaseOrdersController.sendBack);
router.post("/:id/reject", purchaseOrdersController.reject);
router.post("/:id/approve", purchaseOrdersController.approve);

router.patch("/:id", purchaseOrdersController.update);

// Terminal acts by the TENANT — create-level, not activation authority.
// Checked against APPROVE_ROUTE (post|approve|pay|reject|reverse|send-back|
// settle): `cancel`, `close`, `reopen` and `convert` match none of them.
router.post("/:id/cancel", purchaseOrdersController.cancel);
router.post("/:id/close", purchaseOrdersController.close);
router.post("/:id/reopen", purchaseOrdersController.reopen);

// Recording the supplier's bill produces a DRAFT bill — bookkeeper's work.
router.post("/:id/convert", purchaseOrdersController.convert);
router.get("/:id/conversions", purchaseOrdersController.conversions);

router.delete("/:id", purchaseOrdersController.remove);

export default router;
