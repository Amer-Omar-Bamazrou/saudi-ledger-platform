import { Router } from "express";
import { employeesController } from "../controllers/employees.controller";

const router = Router();

router.get("/", employeesController.list);
// 19B S2a: what the reader may read and write of each employee field — before /:id, which would take it as an id.
router.get("/field-access", employeesController.fieldAccess);
router.get("/:id", employeesController.get);
router.post("/", employeesController.create);
router.patch("/:id", employeesController.update);
router.delete("/:id", employeesController.remove);

export default router;
