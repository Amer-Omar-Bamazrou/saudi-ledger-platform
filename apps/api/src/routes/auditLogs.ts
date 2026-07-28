import { Router } from "express";
import { auditLogsController } from "../controllers/auditLogs.controller";

const router = Router();

// GET /api/audit-logs?entity_type=&action=&limit=&offset=
router.get("/", auditLogsController.list);

export default router;
