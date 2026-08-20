/**
 * Purchase order → bill conversion (M21.3).
 *
 * ── 🔴 THE GOVERNING PRINCIPLE (owner-ratified, 2026-08-20) ─────────────────
 *
 *        THE BILL IS THE TRUTH; THE PURCHASE ORDER IS THE EXPECTATION.
 *
 * The supplier's bill is what creates the payable and carries the input VAT.
 * Refusing to record a real liability because it disagrees with our order
 * would be a worse error than recording a variance. So this service PRE-FILLS
 * from the order, lets the caller state what the supplier actually charged,
 * and records the difference as a fact. It never silently reconciles the two,
 * and it never quietly rewrites the order to match the bill.
 *
 * ── 🔴 TWO-WAY MATCH ONLY, AND THE VOCABULARY FOLLOWS ───────────────────────
 * A three-way match (PO / goods receipt / invoice) is impossible here: there
 * is no goods-receipt concept. So we cannot distinguish "the supplier shipped
 * half" from "the supplier billed half", and every word in this file and its
 * responses says BILLED. Nothing may imply knowledge of goods movement.
 *
 * ── One writer per effect ───────────────────────────────────────────────────
 * This builds a bill body and calls `billsService.create` — the same function
 * the manual bill form calls. No `postJournalEntry` here, ever.
 *
 * ── Drafts only ─────────────────────────────────────────────────────────────
 * The produced bill is ALWAYS a draft, inherited from the M21.2 correction:
 * posting a bill moves AP and claims input VAT, a conversion cannot be undone,
 * and a mis-click would then need a correcting entry. There is no
 * `autoApprove` parameter to pass.
 */
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors";
import { assertAmount, assertDateString } from "../lib/writeGuards";
import { purchaseOrdersRepository } from "../repositories/purchaseOrders.repository";
import { billsService } from "./bills.service";
import { auditService } from "./audit.service";

export interface ConvertPoLineInput {
  purchaseOrderItemId: number;
  quantity: number;
  /**
   * What the supplier ACTUALLY charged per unit. Omit to accept the ordered
   * price. Supplying a different figure is not an error — it is the ordinary
   * case this feature exists to handle.
   */
  unitPrice?: number;
}

/** A line the supplier billed that was never on the order (freight, surcharges). */
export interface UnorderedLineInput {
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate?: number;
}

export interface ConvertPurchaseOrderInput {
  lines?: ConvertPoLineInput[];
  /** Lines on the supplier's bill that the order did not contain. */
  unorderedLines?: UnorderedLineInput[];
  /** The supplier's bill date. Defaults to today. */
  date?: string;
  dueDate?: string;
  /** The supplier's own bill number — theirs wins over ours. */
  vendorReference?: string;
  billNumber?: string;
  notes?: string;
  /**
   * 🔴 Explicit override for billing MORE than remains on the order.
   *
   * Refused by default because that is the case where the supplier may simply
   * be wrong and a human should look. It is an override rather than a hard
   * block because over-billing does happen legitimately (a corrected order, a
   * partial delivery re-billed), and refusing outright would mean refusing to
   * record a real liability — which the governing principle forbids.
   */
  allowOverBilling?: boolean;
}

const QTY_EPSILON = 0.0005;

export const purchaseOrderConversionService = {
  async convert(
    purchaseOrderId: number,
    input: ConvertPurchaseOrderInput,
    userId: number | null,
  ) {
    const [po] = await purchaseOrdersRepository.findById(purchaseOrderId);
    if (!po) throw new NotFoundError("Not found");

    if (po.status !== "approved") {
      throw new ConflictError("Only an approved purchase order can be billed. Approve it first.");
    }
    if (po.outcome) {
      throw new ConflictError(`This order was ${po.outcome}. Reopen it before recording a bill.`);
    }
    // An EXPIRED order is not blocked: a supplier billing against a lapsed
    // order is a commercial matter, and the liability is real either way.

    const items = await purchaseOrdersRepository.itemsByOrder(purchaseOrderId);
    if (items.length === 0) throw new BadRequestError("This order has no lines to bill.");

    const alreadyBilled = await purchaseOrdersRepository.billedQuantities(purchaseOrderId);
    const unbilledFor = (itemId: number, quantity: number) =>
      quantity - (alreadyBilled.get(itemId) ?? 0);

    let requested: { item: (typeof items)[number]; quantity: number; unitPrice: number }[];
    if (input.lines === undefined) {
      requested = items
        .map((item) => ({
          item,
          quantity: unbilledFor(item.id, Number(item.quantity)),
          unitPrice: Number(item.unitPrice),
        }))
        .filter((r) => r.quantity > QTY_EPSILON);
      if (requested.length === 0 && !(input.unorderedLines?.length)) {
        throw new ConflictError("Every line on this order has already been billed.");
      }
    } else {
      if (!Array.isArray(input.lines) || input.lines.length === 0) {
        throw new BadRequestError("Select at least one line to bill.");
      }
      const byId = new Map(items.map((i) => [i.id, i]));
      const seen = new Set<number>();
      requested = input.lines.map((line, idx) => {
        const item = byId.get(Number(line.purchaseOrderItemId));
        if (!item) throw new BadRequestError(`Line ${idx + 1} does not belong to this order.`);
        if (seen.has(item.id)) throw new BadRequestError(`Line ${idx + 1} appears more than once.`);
        seen.add(item.id);
        const quantity = assertAmount(line.quantity, `line ${idx + 1} quantity`, { min: 0, allowZero: true });
        if (quantity <= 0) throw new BadRequestError(`Line ${idx + 1} quantity must be greater than zero.`);
        const unitPrice =
          line.unitPrice === undefined
            ? Number(item.unitPrice)
            : assertAmount(line.unitPrice, `line ${idx + 1} unit price`, { min: 0, allowZero: true });
        return { item, quantity, unitPrice };
      });
    }

    // ── Over-billing: refused unless explicitly overridden ─────────────────
    if (!input.allowOverBilling) {
      for (const { item, quantity } of requested) {
        const unbilled = unbilledFor(item.id, Number(item.quantity));
        if (quantity > unbilled + QTY_EPSILON) {
          throw new ConflictError(
            `The supplier billed ${quantity} of "${item.description}" but only ${Math.max(0, unbilled)} remain un-billed on this order. ` +
              `Check the bill against the order. If the supplier is right, resend with allowOverBilling.`,
          );
        }
      }
    }

    const date = input.date ?? new Date().toISOString().slice(0, 10);
    assertDateString(date, "date");
    if (input.dueDate != null) assertDateString(input.dueDate, "dueDate");

    // ── Build the bill ────────────────────────────────────────────────────
    // 🔴 The SUPPLIER'S price is what goes on the bill, not the ordered price.
    // The ordered price stays on the PO line, and the difference surfaces as a
    // recorded variance — never by rewriting either document to match.
    const orderedLines = requested.map(({ item, quantity, unitPrice }) => ({
      productId: item.productId,
      description: item.description,
      descriptionAr: item.descriptionAr,
      quantity,
      unitPrice,
      vatRate: Number(item.vatRate ?? 15),
    }));

    // Lines the supplier billed that were never ordered — freight, surcharges,
    // a substituted part. Real and common, so allowed; they simply have no
    // conversion row, which is what makes them identifiable as unordered.
    const extraLines = (input.unorderedLines ?? []).map((l, idx) => {
      if (!l?.description?.trim()) throw new BadRequestError(`Unordered line ${idx + 1} needs a description.`);
      const quantity = assertAmount(l.quantity, `unordered line ${idx + 1} quantity`, { min: 0, allowZero: true });
      if (quantity <= 0) throw new BadRequestError(`Unordered line ${idx + 1} quantity must be greater than zero.`);
      return {
        description: l.description,
        quantity,
        unitPrice: assertAmount(l.unitPrice, `unordered line ${idx + 1} unit price`, { min: 0, allowZero: true }),
        vatRate: l.vatRate == null ? 15 : Number(l.vatRate),
      };
    });

    if (orderedLines.length === 0 && extraLines.length === 0) {
      throw new BadRequestError("A bill needs at least one line.");
    }

    const billNumber =
      input.billNumber?.trim() ||
      input.vendorReference?.trim() ||
      (await purchaseOrdersRepository.nextBillNumber(date));

    const bill = await billsService.create(
      {
        billNumber,
        vendorReference: input.vendorReference,
        date,
        dueDate: input.dueDate,
        vendorId: po.vendorId,
        currency: po.currency,
        notes: input.notes ?? `From purchase order ${po.orderNumber}`,
        items: [...orderedLines, ...extraLines],
      },
      userId,
    );

    const [conversion] = await purchaseOrdersRepository.insertConversion({
      purchaseOrderId,
      billId: bill.id,
      billedOn: date,
      convertedBy: userId ?? null,
    } as never);

    if (requested.length > 0) {
      await purchaseOrdersRepository.insertConversionItems(
        requested.map(({ item, quantity, unitPrice }) => ({
          conversionId: conversion.id,
          purchaseOrderItemId: item.id,
          quantity: String(quantity),
          unitPrice: unitPrice.toFixed(2),
        })) as never,
      );
    }

    await auditService.created("purchase_order_conversion", conversion.id, {
      purchaseOrderId,
      billId: bill.id,
      billedOn: date,
      lines: requested.map(({ item, quantity, unitPrice }) => ({
        purchaseOrderItemId: item.id,
        quantity,
        unitPrice,
        orderedUnitPrice: Number(item.unitPrice),
      })),
      unorderedLines: extraLines.length,
      overBillingAllowed: !!input.allowOverBilling,
    });

    return { conversion: { id: conversion.id, billedOn: date }, bill };
  },

  /** The dated billing history: what the supplier billed, when, on which bill. */
  async history(purchaseOrderId: number) {
    const [po] = await purchaseOrdersRepository.findById(purchaseOrderId);
    if (!po) throw new NotFoundError("Not found");
    const rows = await purchaseOrdersRepository.conversions(purchaseOrderId);
    return rows.map((r) => ({
      id: r.conv.id,
      billedOn: r.conv.billedOn,
      billId: r.conv.billId,
      billNumber: r.bill?.billNumber ?? null,
      billStatus: r.bill?.status ?? null,
      billTotal: r.bill ? Number(r.bill.total) : null,
    }));
  },
};
