/**
 * Quotation response shaping (M21.1).
 *
 * The one thing worth reading here is {@link conversionState}: the conversion
 * axis is COMPUTED, never stored. See the schema header for why — a single
 * status column cannot express "approved AND partially converted", which is
 * the ordinary state of a partially-accepted quotation.
 *
 * In M21.1 there are no conversions yet, so every live quotation is `open`.
 * M21.2 supplies the real converted quantities; this function is where they
 * arrive, so the shape the UI reads does not change when they do.
 */
import type { quotationsTable, quotationItemsTable, customersTable } from "@workspace/db";

type Quotation = typeof quotationsTable.$inferSelect;
type QuotationItem = typeof quotationItemsTable.$inferSelect;
type Customer = typeof customersTable.$inferSelect;

export const toNum = (v: unknown): number => (v == null ? 0 : Number(v));

/** The conversion axis. Derived from quantities — never read from a column. */
export type ConversionState = "open" | "partially_converted" | "converted";

export interface QuotationItemOut {
  id: number;
  productId: number | null;
  description: string;
  descriptionAr: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
  vatAmount: number;
  discount: number;
  total: number;
  taxCategoryCode: string | null;
  unitCode: string;
  /** How much of this line has become an invoice. M21.2 makes this non-zero. */
  convertedQuantity: number;
  /** `quantity - convertedQuantity` — what a conversion may still take. */
  remainingQuantity: number;
}

export interface QuotationOut {
  id: number;
  quotationNumber: string;
  date: string;
  validUntil: string | null;
  customerId: number | null;
  customerName: string | null;
  /** APPROVAL axis: draft | submitted | approved. */
  status: string;
  /** Terminal tenant act: declined | closed | null (= live). */
  outcome: string | null;
  /** CONVERSION axis — derived, see the module header. */
  conversionState: ConversionState;
  /**
   * 🔴 True when `validUntil` is in the past. Surfaced as a FACT the UI warns
   * on, never as a block: a customer accepting a lapsed quotation is a
   * commercial decision, not an error the software may refuse (design §8.8).
   */
  expired: boolean;
  subtotal: number;
  vatAmount: number;
  discount: number;
  total: number;
  currency: string;
  notes: string | null;
  termsAndConditions: string | null;
  reviewNote: string | null;
  createdAt: string;
  items?: QuotationItemOut[];
}

/**
 * Derive the conversion state from line quantities.
 *
 * Deliberately tolerant at the edges and strict in the middle: it reports
 * `converted` only when NOTHING remains, so a fractional remainder keeps the
 * quotation open rather than rounding it closed. A quotation with no lines is
 * `open` — there is nothing to convert, and calling that "converted" would be
 * a confident wrong answer.
 */
export function conversionState(items: { quantity: number; convertedQuantity: number }[]): ConversionState {
  if (items.length === 0) return "open";
  const ordered = items.reduce((s, i) => s + i.quantity, 0);
  const converted = items.reduce((s, i) => s + i.convertedQuantity, 0);
  // 0.0005 = half of the smallest representable quantity (numeric(15,3)), so
  // this absorbs float noise without ever hiding a real remaining unit.
  if (converted <= 0.0005) return "open";
  if (converted >= ordered - 0.0005) return "converted";
  return "partially_converted";
}

export function buildQuotationItemOut(
  item: QuotationItem,
  convertedQuantity = 0,
): QuotationItemOut {
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
    discount: toNum(item.discount),
    total: toNum(item.total),
    taxCategoryCode: item.taxCategoryCode,
    unitCode: item.unitCode,
    convertedQuantity,
    remainingQuantity: Math.max(0, quantity - convertedQuantity),
  };
}

export function buildQuotationOut(
  quo: Quotation,
  cust: Customer | null,
  items?: QuotationItem[],
  /** line id → converted quantity. Empty in M21.1; supplied by M21.2. */
  convertedByItem: Map<number, number> = new Map(),
  today = new Date().toISOString().slice(0, 10),
  /**
   * 🔴 AUD-3 — the LIST's substitute for line data it does not fetch.
   *
   * `conversionState` is derived from quantities. A caller that has no items
   * must supply the totals instead; a caller that supplies NEITHER gets `open`,
   * which is correct only for a quotation that genuinely has no lines. The list
   * used to be exactly that second caller, and reported every converted
   * quotation as open.
   */
  aggregate?: { quantity: number; convertedQuantity: number },
): QuotationOut {
  const itemsOut = items?.map((i) => buildQuotationItemOut(i, convertedByItem.get(i.id) ?? 0));
  const stateBasis = itemsOut ?? (aggregate ? [aggregate] : []);
  return {
    id: quo.id,
    quotationNumber: quo.quotationNumber,
    date: quo.date,
    validUntil: quo.validUntil,
    customerId: quo.customerId,
    customerName: cust?.name ?? null,
    status: quo.status,
    outcome: quo.outcome,
    conversionState: conversionState(stateBasis),
    expired: !!quo.validUntil && quo.validUntil < today,
    subtotal: toNum(quo.subtotal),
    vatAmount: toNum(quo.vatAmount),
    discount: toNum(quo.discount),
    total: toNum(quo.total),
    currency: quo.currency ?? "SAR",
    notes: quo.notes,
    termsAndConditions: quo.termsAndConditions,
    reviewNote: quo.reviewNote,
    createdAt: quo.createdAt?.toISOString?.() ?? String(quo.createdAt),
    ...(itemsOut ? { items: itemsOut } : {}),
  };
}
