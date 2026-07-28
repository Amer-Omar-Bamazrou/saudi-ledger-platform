import { Router } from "express";
import { categoriesController } from "../controllers/categories.controller";

const router = Router();

router.get("/", categoriesController.list);
router.post("/", categoriesController.create);

export default router;
