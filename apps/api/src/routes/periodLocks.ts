/**
 * Period lock management. Authorization is applied at the router mount via
 * requirePermission("period_locks") in routes/index.ts: read is open to all
 * roles; create (lock) and delete (unlock) are admin-only.
 */
import { Router } from "express";
import { periodLocksController } from "../controllers/periodLocks.controller";

const router = Router();

router.get("/", periodLocksController.list);
router.post("/", periodLocksController.create);
router.delete("/:period", periodLocksController.remove);

export default router;
