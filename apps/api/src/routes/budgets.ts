import { Router } from "express";
import { budgetsController } from "../controllers/budgets.controller";

const router = Router();

router.get("/", budgetsController.list);
router.post("/", budgetsController.create);
router.patch("/:id", budgetsController.update);
router.delete("/:id", budgetsController.remove);

export default router;
