import { Router } from "express";
import { payrollController } from "../controllers/payroll.controller";

const router = Router();

router.get("/", payrollController.list);
router.get("/:id", payrollController.get);
router.post("/", payrollController.create);
// Draft/approval workflow (M10.5): submit is a create-level (bookkeeper) action;
// approve/send-back/reject are approver-only (activation-route override).
router.post("/:id/submit", payrollController.submit);
router.post("/:id/send-back", payrollController.sendBack);
router.post("/:id/reject", payrollController.reject);
router.post("/:id/approve", payrollController.approve);

export default router;
