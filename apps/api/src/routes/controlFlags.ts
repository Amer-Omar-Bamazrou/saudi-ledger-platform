/** Control flags routes (Phase 18 R-11a, DR-14) — thin HTTP; authz via requirePermission("control_flags") at the mount. */
import { Router } from "express";
import { controlFlagsController } from "../controllers/controlFlags.controller";

const router = Router();

router.get("/", controlFlagsController.list);

export default router;
