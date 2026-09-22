import { Router } from "express";
import { assetsController } from "../controllers/assets.controller";

const router = Router();

// FA-A (2026-09-22): the account triple + the Art. 17 group + the Art. 52 class every asset inherits.
router.get("/", assetsController.listCategories);
router.post("/", assetsController.createCategory);
router.put("/:id", assetsController.updateCategory);

export default router;
