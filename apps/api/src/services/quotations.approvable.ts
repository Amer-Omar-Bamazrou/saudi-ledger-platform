/**
 * Quotation approval adapter (M21.1) — plugs quotations into the generic
 * {@link approvalService}.
 *
 * State mapping:
 *   draft     → draft      (editable by the enterer, not in the queue)
 *   submitted → submitted  (locked, in the approver's queue)
 *   approved  → approved   (may be sent to the customer)
 *
 * ── 🔴 What `onApprove` does NOT do, and why that is correct ────────────────
 * Every other adapter's `onApprove` fires an accounting activation path — a JE
 * posts, a bill hits AP/expense/VAT, an invoice is hashed and issued. This one
 * flips a status and nothing else. That is not a stub; it is the feature.
 *
 * A quotation is an OFFER. It is not a supply, so approving it creates no
 * receivable, no output VAT and no ledger entry at all. What approval means
 * here is authority of a different kind: **this price may now go to the
 * customer.** That is why the `approve` grant is withheld from bookkeepers in
 * the permission matrix — not because approval moves money, but because a
 * quotation is a price commitment the business will be held to.
 *
 * The loose fit with the interface's wording was weighed against the
 * alternative (a bespoke status field beside the engine) and rejected: a
 * second lifecycle vocabulary is the more expensive mistake, and the engine
 * carries submit / send-back / reject and the audit trail for free.
 *
 * 🔴 Approval does NOT convert. Conversion (M21.2) is a separate, explicit act
 * that produces a DRAFT invoice through `invoicesService.create` — because
 * agreeing a price is not authority to issue a legal tax document.
 */
import { quotationsRepository } from "../repositories/quotations.repository";
import { buildQuotationOut, type QuotationOut } from "./quotations.presenter";
import type { Approvable, ApprovalState } from "./approval";
import type { quotationsTable, customersTable } from "@workspace/db";

type Quotation = typeof quotationsTable.$inferSelect;
type Customer = typeof customersTable.$inferSelect;
type QuotationRow = { quo: Quotation; cust: Customer | null };

async function snapshot(row: QuotationRow): Promise<QuotationOut> {
  const items = await quotationsRepository.itemsByQuotation(row.quo.id);
  return buildQuotationOut(row.quo, row.cust, items);
}

export function quotationApprovable(): Approvable<QuotationRow, QuotationOut> {
  return {
    entityType: "quotation",

    async load(id) {
      const [row] = await quotationsRepository.findWithCustomer(id);
      return row ?? null;
    },

    state(row): ApprovalState {
      if (row.quo.status === "draft") return "draft";
      if (row.quo.status === "submitted") return "submitted";
      return "approved";
    },

    snapshot,

    async onApprove(row) {
      // The whole activation: the quotation may now be sent. No ledger effect
      // exists to fire — see the module header.
      const [updated] = await quotationsRepository.update(row.quo.id, {
        status: "approved",
        reviewNote: null,
      });
      return snapshot({ quo: updated, cust: row.cust });
    },

    async onSubmit(row) {
      const [updated] = await quotationsRepository.update(row.quo.id, {
        status: "submitted",
        reviewNote: null,
      });
      return snapshot({ quo: updated, cust: row.cust });
    },

    async onSendBack(row, _actor, note) {
      const [updated] = await quotationsRepository.update(row.quo.id, {
        status: "draft",
        reviewNote: note?.trim() ? note.trim() : null,
      });
      return snapshot({ quo: updated, cust: row.cust });
    },

    async hardDelete(row) {
      // Items cascade on the FK, but delete them explicitly so the intent is
      // visible rather than resting on a schema detail a later migration could
      // change without anyone rereading this file.
      await quotationsRepository.deleteItems(row.quo.id);
      await quotationsRepository.delete(row.quo.id);
    },
  };
}
