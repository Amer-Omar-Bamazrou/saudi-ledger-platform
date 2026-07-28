import { Router } from "express";
import { assetsController } from "../controllers/assets.controller";

const router = Router();

router.get("/", assetsController.list);
router.get("/:id", assetsController.get);
router.post("/", assetsController.create);
router.patch("/:id", assetsController.update);
router.post("/:id/depreciate", assetsController.depreciate);
router.delete("/:id", assetsController.remove);

export default router;
