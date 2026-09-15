import { Router } from "express";
import { assetsController } from "../controllers/assets.controller";

const router = Router();

router.get("/", assetsController.list);
router.get("/:id", assetsController.get);
router.post("/", assetsController.create);
router.post("/:id/depreciate", assetsController.depreciate);

export default router;
