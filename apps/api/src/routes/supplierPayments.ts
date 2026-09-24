import { Router } from "express";
import { supplierPaymentsController } from "../controllers/supplierPayments.controller";
import { supplierAdvanceInvoicesController } from "../controllers/supplierAdvanceInvoices.controller";

/**
 * B3/B4 (2026-09-22) — supplier payments, advances and their allocation.
 *
 * 🔴 A PARALLEL MODEL to `/payments`, deliberately, not a shortcut taken for
 * speed. The customer side is structurally customer-specific — its allocation
 * row's `invoice_id` is NOT NULL and points at `invoices`, and its payment row
 * carries `customer_id` — so an AP payment cannot be expressed in it without
 * loosening a constraint that currently prevents a receipt being applied to
 * nothing. The DIRECTION differs too: a customer advance is a liability, a
 * supplier advance is an asset.
 *
 * `/allocations/:id/reverse` is declared BEFORE `/:id`, or Express reads
 * "allocations" as a payment id and the correction is unreachable. `allocate`
 * and `reverse` resolve to the `approve` action through rbac's activation
 * override; `classify` and `refund` stay `create`, matching their customer-side
 * twins (`POST /payments/:id/classify`, `POST /payments/refunds`).
 */
const router = Router();

router.post("/allocations/:id/reverse", supplierPaymentsController.reverseAllocation);

router.get("/", supplierPaymentsController.list);
router.post("/", supplierPaymentsController.create);
router.get("/:id", supplierPaymentsController.get);
router.post("/:id/allocate", supplierPaymentsController.allocate);
router.post("/:id/classify", supplierPaymentsController.classify);
router.post("/:id/refund", supplierPaymentsController.refund);
router.post("/:id/advance-invoices", supplierAdvanceInvoicesController.createAdvanceInvoice);

export default router;
