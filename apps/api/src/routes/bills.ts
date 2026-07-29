import { Router } from "express";
import { billsController } from "../controllers/bills.controller";

const router = Router();

router.get("/", billsController.list);
router.get("/:id", billsController.get);
router.post("/", billsController.create);
// Draft/approval workflow (M10.3): submit is a create-level (bookkeeper) action;
// approve/send-back/reject/pay are approver-only (resolved to the `approve`
// action by requirePermission's activation-route override). `post` aliases approve.
router.post("/:id/submit", billsController.submit);
router.post("/:id/send-back", billsController.sendBack);
router.post("/:id/reject", billsController.reject);
router.post("/:id/approve", billsController.approve);
router.post("/:id/post", billsController.post);
router.patch("/:id", billsController.update);
router.post("/:id/pay", billsController.pay);
router.delete("/:id", billsController.remove);

export default router;
