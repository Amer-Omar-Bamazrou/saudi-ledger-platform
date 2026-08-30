import { Router } from "express";
import { transactionsController } from "../controllers/transactions.controller";

const router = Router();

router.get("/", transactionsController.list);
router.post("/upload", transactionsController.upload);
// M15 holding area: list pending imported rows; accept them (bulk or named).
router.get("/review", transactionsController.pendingReview);
router.get("/review/counts", transactionsController.pendingReviewCounts);
router.post("/review/accept", transactionsController.acceptPending);
// M16.3: accept a pending row AS a settlement of an invoice/bill. The `settle`
// suffix resolves to the `approve` action (rbac.ts) — it records a payment.
router.post("/:id/settle", transactionsController.settle);
router.post("/", transactionsController.create);
router.get("/:id", transactionsController.get);
router.patch("/:id", transactionsController.update);
router.delete("/:id", transactionsController.remove);

export default router;
