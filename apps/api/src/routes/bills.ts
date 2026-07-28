import { Router } from "express";
import { billsController } from "../controllers/bills.controller";

const router = Router();

router.get("/", billsController.list);
router.get("/:id", billsController.get);
router.post("/", billsController.create);
router.post("/:id/post", billsController.post);
router.patch("/:id", billsController.update);
router.post("/:id/pay", billsController.pay);
router.delete("/:id", billsController.remove);

export default router;
