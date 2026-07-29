import { Router } from "express";
import { invoicesController } from "../controllers/invoices.controller";

const router = Router();

router.get("/", invoicesController.list);
router.get("/:id", invoicesController.get);
router.post("/", invoicesController.create);
// Draft/approval workflow (M10.4): submit is a create-level (bookkeeper) action;
// approve/send-back/reject/pay are approver-only (resolved to the `approve`
// action by requirePermission's activation-route override).
router.post("/:id/submit", invoicesController.submit);
router.post("/:id/send-back", invoicesController.sendBack);
router.post("/:id/reject", invoicesController.reject);
router.post("/:id/approve", invoicesController.approve);
router.patch("/:id", invoicesController.update);
router.post("/:id/pay", invoicesController.pay);
router.delete("/:id", invoicesController.remove);

export default router;
