import { Router } from "express";
import { reportsController } from "../../controllers/reports.controller";

const router = Router();
router.get("/", reportsController.apAging);
export default router;
