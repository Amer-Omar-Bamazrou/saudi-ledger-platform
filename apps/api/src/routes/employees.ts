import { Router } from "express";
import { employeesController } from "../controllers/employees.controller";

const router = Router();

router.get("/", employeesController.list);
router.get("/:id", employeesController.get);
router.post("/", employeesController.create);
router.patch("/:id", employeesController.update);
router.delete("/:id", employeesController.remove);

export default router;
