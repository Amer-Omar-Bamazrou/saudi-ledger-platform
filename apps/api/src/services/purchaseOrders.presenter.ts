/**
 * Purchase order response shaping (M21.3).
 *
 * 🔴 EVERY USER-FACING WORD HERE IS ABOUT BILLING, NOT DELIVERY.
 *
 * The platform has no goods-receipt concept, so a PO↔bill match is TWO-way.
 * We cannot distinguish "the supplier shipped half" from "the supplier billed
 * half", and the owner's instruction was explicit that pretending otherwise
 * would be a confident wrong answer. So the states are `open` /
 * `partially_billed` / `fully_billed`, the remaining quantity is `unbilledQuantity`,
 * and nothing in this file may acquire a word like "received", "delivered" or
 * "outstanding stock".
 *
 * A reviewer of this milestone should read the PO screen looking for a word
 * that claims knowledge of goods movement. There must not be one.
 */
import type { purchaseOrdersTable, purchaseOrderItemsTable, vendorsTable } from "@workspace/db";

type PurchaseOrder = typeof purchaseOrdersTable.$inferSelect;
type PurchaseOrderItem = typeof purchaseOrderItemsTable.$inferSelect;
type Vendor = typeof vendorsTable.$inferSelect;

export const toNum = (v: unknown): number => (v == null ? 0 : Number(v));

/** The billing axis. Derived from quantities — never read from a column. */
export type BillingState = "open" | "partially_billed" | "fully_billed";

export interface PriceVariance {
  /** What we ordered at. */
  orderedUnitPrice: number;
  /** What the supplier actually billed, per event. */
  billedUnitPrice: number;
  quantity: number;
  billedOn: string;
  /** billed − ordered, per unit. Positive = the supplier charged more. */
  difference: number;
}

export interface PurchaseOrderItemOut {
  id: number;
  productId: number | null;
  description: string;
  descriptionAr: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
  vatAmount: number;
  total: number;
  unitCode: string;
  /** How much of this line the supplier has billed. NOT how much arrived. */
  billedQuantity: number;
  /** `quantity - billedQuantity`. Un-billed, NOT "outstanding". */
  unbilledQuantity: number;
  /**
   * Every event where the supplier's price differed from the ordered price.
   * Empty when they billed what was agreed.
   *
   * 🔴 Reported as a neutral FACT with both figures, never as a status colour
   * — a price variance is a judgment ("is this acceptable?"), and the status
   * palette is reserved for things that ARE the case (CLAUDE.md §4).
   */
  priceVariances: PriceVariance[];
}

export interface PurchaseOrderOut {
  id: number;
  orderNumber: string;
  date: string;
  validUntil: string | null;
  vendorId: number | null;
  vendorName: string | null;
  status: string;
  /** cancelled | closed | null (= live). Cancelled by US, never "declined". */
  outcome: string | null;
  billingState: BillingState;
  expired: boolean;
  subtotal: number;
  vatAmount: number;
  total: number;
  currency: string;
  notes: string | null;
  reviewNote: string | null;
  createdAt: string;
  items?: PurchaseOrderItemOut[];
}

export function billingState(items: { quantity: number; billedQuantity: number }[]): BillingState {
  if (items.length === 0) return "open";
  const ordered = items.reduce((s, i) => s + i.quantity, 0);
  const billed = items.reduce((s, i) => s + i.billedQuantity, 0);
  if (billed <= 0.0005) return "open";
  // 🔴 `>=` not `===`: over-billing (allowed with an explicit override) still
  // means nothing is left un-billed. Reporting an over-billed order as
  // "partially billed" would be plainly wrong.
  if (billed >= ordered - 0.0005) return "fully_billed";
  return "partially_billed";
}

export function buildPurchaseOrderItemOut(
  item: PurchaseOrderItem,
  billedQuantity = 0,
  priceVariances: PriceVariance[] = [],
): PurchaseOrderItemOut {
  const quantity = toNum(item.quantity);
  return {
    id: item.id,
    productId: item.productId,
    description: item.description,
    descriptionAr: item.descriptionAr,
    quantity,
    unitPrice: toNum(item.unitPrice),
    vatRate: toNum(item.vatRate),
    vatAmount: toNum(item.vatAmount),
    total: toNum(item.total),
    unitCode: item.unitCode,
    billedQuantity,
    unbilledQuantity: Math.max(0, quantity - billedQuantity),
    priceVariances,
  };
}

export function buildPurchaseOrderOut(
  po: PurchaseOrder,
  vendor: Vendor | null,
  items?: PurchaseOrderItem[],
  billedByItem: Map<number, number> = new Map(),
  variancesByItem: Map<number, PriceVariance[]> = new Map(),
  today = new Date().toISOString().slice(0, 10),
): PurchaseOrderOut {
  const itemsOut = items?.map((i) =>
    buildPurchaseOrderItemOut(i, billedByItem.get(i.id) ?? 0, variancesByItem.get(i.id) ?? []),
  );
  return {
    id: po.id,
    orderNumber: po.orderNumber,
    date: po.date,
    validUntil: po.validUntil,
    vendorId: po.vendorId,
    vendorName: vendor?.name ?? null,
    status: po.status,
    outcome: po.outcome,
    billingState: billingState(itemsOut ?? []),
    expired: !!po.validUntil && po.validUntil < today,
    subtotal: toNum(po.subtotal),
    vatAmount: toNum(po.vatAmount),
    total: toNum(po.total),
    currency: po.currency ?? "SAR",
    notes: po.notes,
    reviewNote: po.reviewNote,
    createdAt: po.createdAt?.toISOString?.() ?? String(po.createdAt),
    ...(itemsOut ? { items: itemsOut } : {}),
  };
}
