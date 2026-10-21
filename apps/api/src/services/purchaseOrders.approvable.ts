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
import { checkedState, TransitionNotApplied, type Approvable, type ApprovalState } from "./approval";
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
    // 🔴 Phase 18 (2.4, proof e3): every write below applies only from the state the engine checked (the mirror of
    // quotations: transitions keyed on id alone let a loser overwrite or remove an approved order, or answer 500).
    compareAndSet: true,

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

    async onApprove(row, _actor, from) {
      const [updated] = await purchaseOrdersRepository.updateIfStatus(row.po.id, checkedState(from), {
        status: "approved",
        reviewNote: null,
      });
      if (!updated) throw new TransitionNotApplied();
      return snapshot({ po: updated, vendor: row.vendor });
    },

    async onSubmit(row) {
      const [updated] = await purchaseOrdersRepository.updateIfStatus(row.po.id, "draft", {
        status: "submitted",
        reviewNote: null,
      });
      if (!updated) throw new TransitionNotApplied();
      return snapshot({ po: updated, vendor: row.vendor });
    },

    async onSendBack(row, _actor, note) {
      const [updated] = await purchaseOrdersRepository.updateIfStatus(row.po.id, "submitted", {
        status: "draft",
        reviewNote: note?.trim() ? note.trim() : null,
      });
      if (!updated) throw new TransitionNotApplied();
      return snapshot({ po: updated, vendor: row.vendor });
    },

    async hardDelete(row, from) {
      // Removed only while still in the state the engine checked; its lines cascade on the FK.
      const [removed] = await purchaseOrdersRepository.removeIfStatus(row.po.id, checkedState(from));
      if (!removed) throw new TransitionNotApplied();
    },
  };
}
