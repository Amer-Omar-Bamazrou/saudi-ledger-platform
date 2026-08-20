/**
 * Purchase orders service (M21.3).
 *
 * 🔴 THE INVARIANT: a purchase order moves NOTHING. No `postJournalEntry`, no
 * period-lock check, no AP, no input VAT, at any status. A PO dated inside a
 * closed period is deliberately allowed — the lock protects the ledger, and a
 * PO never reaches it.
 *
 * Line arithmetic mirrors `bills` (round each line, then sum), because
 * conversion turns these lines into bill lines. 🔴 Note what is ABSENT: there
 * is no discount handling here, because `bill_items` has no discount column
 * and neither does `bills`. Carrying one would mean silently dropping it at
 * conversion. A supplier discount belongs in the agreed unit price.
 */
import { ConflictError, NotFoundError, BadRequestError } from "../lib/errors";
import { pick, assertAmount, assertRate, assertDateString } from "../lib/writeGuards";
import { auditService } from "./audit.service";
import { approvalService } from "./approval";
import { purchaseOrderApprovable } from "./purchaseOrders.approvable";
import {
  purchaseOrdersRepository,
  type PurchaseOrderListFilter,
} from "../repositories/purchaseOrders.repository";
import { buildPurchaseOrderOut, type PriceVariance } from "./purchaseOrders.presenter";

const round2 = (n: number) => Math.round(n * 100) / 100;

const PO_FIELDS = ["date", "validUntil", "vendorId", "currency", "notes"] as const;

function prepareItems(items: any[]) {
  let subtotal = 0;
  let vatTotal = 0;
  const prepared = items.map((it: any) => {
    const base = round2(Number(it.quantity) * Number(it.unitPrice));
    const vatRate = Number(it.vatRate ?? 15);
    const vat = round2(base * (vatRate / 100));
    subtotal = round2(subtotal + base);
    vatTotal = round2(vatTotal + vat);
    return {
      productId: it.productId ?? null,
      description: String(it.description ?? ""),
      ...(it.descriptionAr ? { descriptionAr: String(it.descriptionAr) } : {}),
      quantity: String(it.quantity),
      unitPrice: String(it.unitPrice),
      vatRate: String(vatRate),
      vatAmount: vat.toFixed(2),
      total: round2(base + vat).toFixed(2),
      ...(it.unitCode ? { unitCode: String(it.unitCode) } : {}),
    };
  });
  return { prepared, subtotal, vatTotal };
}

function validateItems(items: any[]) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequestError("A purchase order needs at least one line.");
  }
  items.forEach((it, i) => {
    if (!it || typeof it.description !== "string" || !it.description.trim()) {
      throw new BadRequestError(`Line ${i + 1} needs a description.`);
    }
    // `assertAmount(.., {min: 0})` ACCEPTS zero (its guard is `n < min`), so
    // the `> 0` is explicit — same reading that would otherwise have let a
    // zero-quantity line reach the DB CHECK as a raw 500.
    const qty = assertAmount(it.quantity, `line ${i + 1} quantity`, { min: 0, allowZero: true });
    if (qty <= 0) throw new BadRequestError(`Line ${i + 1} quantity must be greater than zero.`);
    assertAmount(it.unitPrice, `line ${i + 1} unit price`, { min: 0, allowZero: true });
    if (it.vatRate != null) assertRate(it.vatRate, `line ${i + 1} VAT rate`);
  });
}

/**
 * Refuse an edit that would rewrite a line the supplier has already billed.
 * The mirror of the quotation freeze rule, and the reason is the same: the
 * bill it produced already quotes those numbers.
 */
async function assertBilledLinesUnchanged(purchaseOrderId: number, incoming: any[]) {
  const billed = await purchaseOrdersRepository.billedQuantities(purchaseOrderId);
  if (billed.size === 0) return;

  const existing = await purchaseOrdersRepository.itemsByOrder(purchaseOrderId);
  const incomingById = new Map<number, any>();
  for (const line of incoming) if (line?.id != null) incomingById.set(Number(line.id), line);

  for (const item of existing) {
    if ((billed.get(item.id) ?? 0) <= 0) continue;
    const line = incomingById.get(item.id);
    if (!line) {
      throw new ConflictError(
        `"${item.description}" has already been billed and cannot be removed from this order.`,
      );
    }
    if (Math.abs(Number(line.quantity) - Number(item.quantity)) > 0.0005) {
      throw new ConflictError(
        `"${item.description}" has already been billed; its ordered quantity can no longer be changed.`,
      );
    }
    if (Math.abs(Number(line.unitPrice) - Number(item.unitPrice)) > 0.005) {
      throw new ConflictError(
        `"${item.description}" has already been billed; the ordered price can no longer be changed. The supplier's actual price is recorded on the bill.`,
      );
    }
  }
}

export const purchaseOrdersService = {
  async list(filter: PurchaseOrderListFilter) {
    const rows = await purchaseOrdersRepository.list(filter);
    return rows.map((r) => buildPurchaseOrderOut(r.po, r.vendor));
  },

  async getById(id: number) {
    const [row] = await purchaseOrdersRepository.findWithVendor(id);
    if (!row) throw new NotFoundError("Not found");
    const items = await purchaseOrdersRepository.itemsByOrder(id);
    const billed = await purchaseOrdersRepository.billedQuantities(id);

    // Price variances, derived by comparing what we ORDERED at against what
    // the supplier actually billed on each event. Only differences are
    // reported — a supplier who billed the agreed price produces nothing here.
    const billedLines = await purchaseOrdersRepository.billedLines(id);
    const orderedPrice = new Map(items.map((i) => [i.id, Number(i.unitPrice)]));
    const variances = new Map<number, PriceVariance[]>();
    for (const line of billedLines) {
      const ordered = orderedPrice.get(line.purchaseOrderItemId);
      if (ordered === undefined) continue;
      const billedPrice = Number(line.unitPrice);
      if (Math.abs(billedPrice - ordered) <= 0.005) continue;
      const list = variances.get(line.purchaseOrderItemId) ?? [];
      list.push({
        orderedUnitPrice: ordered,
        billedUnitPrice: billedPrice,
        quantity: Number(line.quantity),
        billedOn: line.billedOn,
        difference: round2(billedPrice - ordered),
      });
      variances.set(line.purchaseOrderItemId, list);
    }

    return buildPurchaseOrderOut(row.po, row.vendor, items, billed, variances);
  },

  async create(body: Record<string, any>, userId: number | null, opts: { autoApprove?: boolean } = {}) {
    const { items = [] } = body;
    validateItems(items);

    const header = pick<Record<string, unknown>>(body, [...PO_FIELDS]) as Record<string, any>;
    const date = header.date ?? new Date().toISOString().slice(0, 10);
    assertDateString(date, "date");
    if (header.validUntil != null) assertDateString(header.validUntil, "validUntil");

    // 🔴 NO period-lock check — a closed period protects the ledger, and a PO
    // never touches it.

    const { prepared, subtotal, vatTotal } = prepareItems(items);
    const orderNumber = await purchaseOrdersRepository.nextNumber(date);

    const [po] = await purchaseOrdersRepository.insert({
      ...header,
      date,
      orderNumber,
      subtotal: subtotal.toFixed(2),
      vatAmount: vatTotal.toFixed(2),
      total: round2(subtotal + vatTotal).toFixed(2),
      status: "draft",
      createdBy: userId ?? null,
    } as never);

    await purchaseOrdersRepository.insertItems(
      prepared.map((p) => ({ ...p, purchaseOrderId: po.id })) as never,
    );
    await auditService.created("purchase_order", po.id, po);

    if (opts.autoApprove) {
      return approvalService.approve(purchaseOrderApprovable(), po.id, { userId: userId ?? null });
    }
    return this.getById(po.id);
  },

  /**
   * Edit. Allowed while `draft` and while `approved` — an order the supplier
   * has not yet billed can still be renegotiated. Locked while `submitted`,
   * and after a terminal outcome.
   *
   * Lines are RECONCILED BY ID rather than replaced wholesale: a billed line
   * must keep its id or the conversion rows referencing it are orphaned (and
   * the RESTRICT FK turns the attempt into a raw 500). That defect was found
   * on the quotation side; it is not repeated here.
   */
  async update(id: number, data: Record<string, any>) {
    const [existing] = await purchaseOrdersRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status === "submitted") {
      throw new ConflictError("A submitted order is locked while it awaits approval. Ask for it to be sent back.");
    }
    if (existing.outcome) {
      throw new ConflictError(`This order was ${existing.outcome} and can no longer be edited.`);
    }

    const values = pick<Record<string, unknown>>(data, [...PO_FIELDS, "reviewNote"]) as Record<string, any>;
    if (values.date !== undefined) assertDateString(values.date, "date");
    if (values.validUntil != null) assertDateString(values.validUntil, "validUntil");

    if (data.items !== undefined) {
      validateItems(data.items);
      await assertBilledLinesUnchanged(id, data.items);
      const { prepared, subtotal, vatTotal } = prepareItems(data.items);
      values.subtotal = subtotal.toFixed(2);
      values.vatAmount = vatTotal.toFixed(2);
      values.total = round2(subtotal + vatTotal).toFixed(2);

      const existingItems = await purchaseOrdersRepository.itemsByOrder(id);
      const existingIds = new Set(existingItems.map((i) => i.id));
      const keptIds = new Set<number>();
      for (let idx = 0; idx < prepared.length; idx++) {
        const incomingId = data.items[idx]?.id;
        if (incomingId != null && existingIds.has(Number(incomingId))) {
          keptIds.add(Number(incomingId));
          await purchaseOrdersRepository.updateItem(Number(incomingId), prepared[idx] as never);
        } else {
          await purchaseOrdersRepository.insertItems([{ ...prepared[idx], purchaseOrderId: id }] as never);
        }
      }
      await purchaseOrdersRepository.deleteItemsByIds([...existingIds].filter((e) => !keptIds.has(e)));
    }

    const [updated] = await purchaseOrdersRepository.update(id, values);
    await auditService.updated("purchase_order", id, existing, updated);
    return this.getById(id);
  },

  submit(id: number, userId: number | null) {
    return approvalService.submit(purchaseOrderApprovable(), id, { userId: userId ?? null });
  },

  approve(id: number, userId: number | null) {
    return approvalService.approve(purchaseOrderApprovable(), id, { userId: userId ?? null });
  },

  sendBack(id: number, userId: number | null, note?: string) {
    return approvalService.sendBack(purchaseOrderApprovable(), id, { userId: userId ?? null }, note);
  },

  reject(id: number, userId: number | null) {
    return approvalService.reject(purchaseOrderApprovable(), id, { userId: userId ?? null });
  },

  /**
   * The tenant's terminal act.
   *
   * 🔴 `cancelled`, not `declined` — WE withdraw a purchase order. Saying the
   * supplier declined it would assert something we have no way to know, which
   * is the same class of error as claiming a delivery we cannot see.
   */
  async setOutcome(id: number, outcome: "cancelled" | "closed") {
    const [existing] = await purchaseOrdersRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "approved") {
      throw new ConflictError("Only an issued order can be cancelled or closed.");
    }
    if (existing.outcome) throw new ConflictError(`This order is already ${existing.outcome}.`);
    const [updated] = await purchaseOrdersRepository.update(id, { outcome });
    await auditService.updated("purchase_order", id, existing, updated);
    return this.getById(id);
  },

  async reopen(id: number) {
    const [existing] = await purchaseOrdersRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (!existing.outcome) throw new ConflictError("This order is already live.");
    const [updated] = await purchaseOrdersRepository.update(id, { outcome: null });
    await auditService.updated("purchase_order", id, existing, updated);
    return this.getById(id);
  },

  async remove(id: number) {
    const [existing] = await purchaseOrdersRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (await purchaseOrdersRepository.hasConversions(id)) {
      throw new ConflictError(
        "This order has been billed and cannot be deleted. Close it instead.",
      );
    }
    await purchaseOrdersRepository.deleteItems(id);
    await purchaseOrdersRepository.delete(id);
    await auditService.deleted("purchase_order", id, existing);
    return { deleted: true };
  },
};
