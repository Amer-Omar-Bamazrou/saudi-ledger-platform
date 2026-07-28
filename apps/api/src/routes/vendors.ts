import { Router } from "express";
import { vendorsController } from "../controllers/vendors.controller";

const router = Router();

router.get("/", vendorsController.list);
router.get("/:id", vendorsController.get);
router.post("/match", vendorsController.match);
router.post("/", vendorsController.create);
router.patch("/:id", vendorsController.update);
router.delete("/:id", vendorsController.remove);

export default router;
