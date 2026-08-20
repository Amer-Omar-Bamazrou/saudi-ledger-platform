/**
 * Purchase order approval adapter (M21.3) — the mirror of
 * `quotations.approvable.ts`.
 *
 * `onApprove` fires no accounting activation, for the same reason it does not
 * on a quotation: a purchase order is an INTENTION TO BUY, not a purchase.
 * Nothing has been supplied, so there is no payable, no input VAT and no
 * ledger entry. What approval means here is **this order may go to the
 * supplier** — which commits the business to buy, and is why `approve` is
 * withheld from bookkeepers in the permission matrix.
 *
 * 🔴 Approval does NOT create a bill. Conversion is a separate, explicit act
 * that happens when the SUPPLIER'S BILL ARRIVES, and it produces a DRAFT bill
 * an approver still has to post.
 */
import { purchaseOrdersRepository } from "../repositories/purchaseOrders.repository";
import { buildPurchaseOrderOut, type PurchaseOrderOut } from "./purchaseOrders.presenter";
import type { Approvable, ApprovalState } from "./approval";
import type { purchaseOrdersTable, vendorsTable } from "@workspace/db";

type PurchaseOrder = typeof purchaseOrdersTable.$inferSelect;
type Vendor = typeof vendorsTable.$inferSelect;
type PurchaseOrderRow = { po: PurchaseOrder; vendor: Vendor | null };

async function snapshot(row: PurchaseOrderRow): Promise<PurchaseOrderOut> {
  const items = await purchaseOrdersRepository.itemsByOrder(row.po.id);
  return buildPurchaseOrderOut(row.po, row.vendor, items);
}

export function purchaseOrderApprovable(): Approvable<PurchaseOrderRow, PurchaseOrderOut> {
  return {
    entityType: "purchase_order",

    async load(id) {
      const [row] = await purchaseOrdersRepository.findWithVendor(id);
      return row ?? null;
    },

    state(row): ApprovalState {
      if (row.po.status === "draft") return "draft";
      if (row.po.status === "submitted") return "submitted";
      return "approved";
    },

    snapshot,

    async onApprove(row) {
      const [updated] = await purchaseOrdersRepository.update(row.po.id, {
        status: "approved",
        reviewNote: null,
      });
      return snapshot({ po: updated, vendor: row.vendor });
    },

    async onSubmit(row) {
      const [updated] = await purchaseOrdersRepository.update(row.po.id, {
        status: "submitted",
        reviewNote: null,
      });
      return snapshot({ po: updated, vendor: row.vendor });
    },

    async onSendBack(row, _actor, note) {
      const [updated] = await purchaseOrdersRepository.update(row.po.id, {
        status: "draft",
        reviewNote: note?.trim() ? note.trim() : null,
      });
      return snapshot({ po: updated, vendor: row.vendor });
    },

    async hardDelete(row) {
      await purchaseOrdersRepository.deleteItems(row.po.id);
      await purchaseOrdersRepository.delete(row.po.id);
    },
  };
}
