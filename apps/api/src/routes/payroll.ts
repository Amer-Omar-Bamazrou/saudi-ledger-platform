import { Router } from "express";
import { payrollController } from "../controllers/payroll.controller";

const router = Router();

router.get("/", payrollController.list);
router.get("/:id", payrollController.get);
router.post("/", payrollController.create);
router.post("/:id/approve", payrollController.approve);

export default router;
