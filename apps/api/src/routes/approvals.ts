/**
 * The pending-approvals queue (batch 5, owner decision A).
 *
 * Mounted behind `requireAnyPermission([...])` — the caller must hold READ on
 * at least one of the four entities — and the service then filters to exactly
 * the ones they hold. 🔴 It was first mounted BARE, on the reasoning that the
 * service filters anyway; `tests/privilege-surface-map` failed it, correctly:
 * that is the guard-that-exempts-a-class-from-itself shape, and the next route
 * mounted beside it would have inherited no guard at all.
 *
 * Every ACTION on a row still posts to that entity's own route, behind that
 * entity's own permission.
 */
import { Router } from "express";
import { approvalsController } from "../controllers/approvals.controller";

const router = Router();

router.get("/pending", approvalsController.pending);

export default router;
