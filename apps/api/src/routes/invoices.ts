import { Router } from "express";
import { invoicesController } from "../controllers/invoices.controller";

const router = Router();

router.get("/", invoicesController.list);
router.get("/:id", invoicesController.get);
router.post("/", invoicesController.create);
router.patch("/:id", invoicesController.update);
router.post("/:id/pay", invoicesController.pay);
router.delete("/:id", invoicesController.remove);

export default router;
