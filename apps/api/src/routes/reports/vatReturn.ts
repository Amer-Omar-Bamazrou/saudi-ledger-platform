import { Router } from "express";
import { reportsController } from "../../controllers/reports.controller";

const router = Router();
router.get("/", reportsController.vatReturn);
export default router;
