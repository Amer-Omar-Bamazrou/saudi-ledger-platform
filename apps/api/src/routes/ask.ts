/** Grounded answers routes (AI-6a) — authz via requirePermission("ask") at the mount. */
import { Router } from "express";
import { askController } from "../controllers/ask.controller";

const router = Router();

router.get("/", askController.list);
router.get("/status", askController.status);
router.post("/", askController.ask);

export default router;
