import { Router } from "express";
import { transactionsController } from "../controllers/transactions.controller";

const router = Router();

router.get("/", transactionsController.list);
router.post("/upload", transactionsController.upload);
router.post("/", transactionsController.create);
router.get("/:id", transactionsController.get);
router.patch("/:id", transactionsController.update);
router.delete("/:id", transactionsController.remove);

export default router;
