import { Router } from "express";
import { invoicesController } from "../controllers/invoices.controller";

const router = Router();

router.get("/", invoicesController.list);
router.get("/:id", invoicesController.get);
router.post("/", invoicesController.create);
// Draft/approval workflow (M10.4): submit is a create-level (bookkeeper) action;
// approve/send-back/reject/pay are approver-only (resolved to the `approve`
// action by requirePermission's activation-route override).
router.post("/:id/submit", invoicesController.submit);
router.post("/:id/send-back", invoicesController.sendBack);
router.post("/:id/reject", invoicesController.reject);
router.post("/:id/approve", invoicesController.approve);
// AP-3: a DRAFT credit note against an ADVANCE tax invoice (:id = the 386) — the
// controlled cancellation path; approval is the separate act on /:id/approve.
router.post("/:id/advance-credit-notes", invoicesController.creditAdvance);
// 2026-09-22: bad debts — the Art. 40(7) write-off with relief, and the Art. 40(9) recovery document.
router.post("/:id/bad-debt-relief", invoicesController.writeOffBadDebt);
router.post("/:id/bad-debt-recoveries", invoicesController.createBadDebtRecovery);
router.patch("/:id", invoicesController.update);
router.post("/:id/pay", invoicesController.pay);
router.get("/:id/payments", invoicesController.payments);
// L1 — the rendered document (PDF/A-3): ?lang=ar is the tax invoice, ?lang=en
// the labelled translation. Read-level action: downloading is bookkeeper work.
router.get("/:id/document", invoicesController.document);
router.delete("/:id", invoicesController.remove);

export default router;
