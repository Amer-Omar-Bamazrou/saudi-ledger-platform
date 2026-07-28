import { Router } from "express";
import { bankAccountsController } from "../controllers/bankAccounts.controller";

const router = Router();

router.get("/", bankAccountsController.list);
router.get("/:id", bankAccountsController.get);
router.post("/", bankAccountsController.create);
router.patch("/:id", bankAccountsController.update);
router.delete("/:id", bankAccountsController.remove);

export default router;
