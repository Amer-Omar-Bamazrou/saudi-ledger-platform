import { Router } from "express";
import { paymentsController } from "../controllers/payments.controller";

/**
 * D-4 (2026-09-17) — customer payments. `POST /` records a receipt (posts;
 * approver-level via the permission matrix); `/:id/allocate` applies an
 * unapplied remainder to invoices (approver-level via rbac's activation
 * override). Refunds (`direction = out`) are Part 2 and have no route yet.
 */
const router = Router();

// Literal sub-mounts BEFORE "/:id", or "refunds" would be parsed as an id.
// Phase C: refunds settle an existing deposit or credit-note balance (post; approver-level).
router.get("/refunds", paymentsController.listRefunds);
router.get("/refunds/:id", paymentsController.getRefund);
router.post("/refunds", paymentsController.refund);
// Phase A: an allocation and its correction (a superseding record; approver-level via the activation override).
router.get("/allocations/:id", paymentsController.getAllocation);
router.post("/allocations/:id/unallocate", paymentsController.unallocate);

router.get("/", paymentsController.list);
router.get("/:id", paymentsController.get);
router.post("/", paymentsController.receive);
router.post("/:id/allocate", paymentsController.allocate);
// A credit note's unconsumed balance applied to other invoices of the same
// customer — an allocation from a CREDIT source (posts Dr Customer credit
// balances / Cr AR; approver-level via the activation override). The note
// itself is an `invoices` row and is never touched.
router.get("/credit-notes/:id/applications", paymentsController.creditApplications);
router.post("/credit-notes/:id/apply", paymentsController.applyCredit);

export default router;
