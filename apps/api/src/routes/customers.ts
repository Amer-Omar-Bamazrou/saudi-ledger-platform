import { Router } from "express";
import { customersController } from "../controllers/customers.controller";

const router = Router();

router.get("/", customersController.list);
router.get("/:id", customersController.get);
// D-4: the customer's credit position — deposits and credit-note balances, apart.
router.get("/:id/credits", customersController.credits);
// Phase E: the statement — every event in chronology, three running balances, a derived net.
router.get("/:id/statement", customersController.statement);
router.post("/", customersController.create);
router.patch("/:id", customersController.update);
router.delete("/:id", customersController.remove);

export default router;
