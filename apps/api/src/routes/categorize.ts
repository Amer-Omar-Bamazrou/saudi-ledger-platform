import { Router } from "express";
import { categorizeController } from "../controllers/categorize.controller";

const router = Router();

router.post("/", categorizeController.run);

export default router;
