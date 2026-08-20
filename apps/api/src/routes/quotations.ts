import { Router } from "express";
import { quotationsController } from "../controllers/quotations.controller";

const router = Router();

router.get("/", quotationsController.list);
router.get("/:id", quotationsController.get);
router.post("/", quotationsController.create);

// Approval workflow (M10 engine). `submit` is create-level (the enterer's own
// action); approve / send-back / reject resolve to the `approve` action via
// requirePermission's APPROVE_ROUTE override — so a bookkeeper may draft a
// quotation but not release the price to a customer.
router.post("/:id/submit", quotationsController.submit);
router.post("/:id/send-back", quotationsController.sendBack);
router.post("/:id/reject", quotationsController.reject);
router.post("/:id/approve", quotationsController.approve);

router.patch("/:id", quotationsController.update);

// 🔴 Terminal acts by the TENANT — deliberately NOT matched by APPROVE_ROUTE,
// so they stay create-level. Recording that a customer declined a quotation is
// bookkeeping, not activation authority: nothing is issued and nothing moves.
// (`/decline` and `/close` were checked against that regex — it matches
// post|approve|pay|reject|reverse|send-back|settle, none of which they are.)
router.post("/:id/decline", quotationsController.decline);
router.post("/:id/close", quotationsController.close);
router.post("/:id/reopen", quotationsController.reopen);

// 🔴 Conversion is CREATE-level, deliberately. It produces a DRAFT invoice
// (unless the caller separately holds invoices:approve), and drafting an
// invoice is a bookkeeper's ordinary work. `convert` is therefore absent from
// rbac.ts's APPROVE_ROUTE regex — checked, not assumed: that regex matches
// post|approve|pay|reject|reverse|send-back|settle.
router.post("/:id/convert", quotationsController.convert);
router.get("/:id/conversions", quotationsController.conversions);

router.delete("/:id", quotationsController.remove);

export default router;
