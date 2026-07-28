import { Router } from "express";
import { customersController } from "../controllers/customers.controller";

const router = Router();

router.get("/", customersController.list);
router.get("/:id", customersController.get);
router.post("/", customersController.create);
router.patch("/:id", customersController.update);
router.delete("/:id", customersController.remove);

export default router;
