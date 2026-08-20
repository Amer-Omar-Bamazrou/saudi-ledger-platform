/**
 * Purchase orders (M21.3) — an INTENTION TO BUY. Not a purchase.
 *
 * The mirror of `quotations.ts`, and everything in that file's header applies:
 * a PO touches nothing (no GL, no AP, no input VAT, no report line at any
 * status); `status` carries the APPROVAL axis only; the CONVERSION axis is
 * DERIVED from line quantities and never stored; `outcome` is a terminal act
 * the TENANT performs and NULL means live.
 *
 * ── 🔴 THREE DELIBERATE DIFFERENCES FROM THE QUOTATION MIRROR ───────────────
 *
 * 1. **No `discount` column, on the line or the header.** Verified, not
 *    assumed: `bill_items` has no discount column and neither does `bills`
 *    (invoices have both). A discount here would therefore be silently
 *    dropped at conversion — "partial data is not lenient data" says never
 *    return part of a value as the whole value, and a field that cannot
 *    survive the one thing this document exists to do is a lying field. A
 *    supplier discount belongs in the unit price you agreed.
 *
 * 2. **No `tax_category_code`.** Same reason: `bill_items` does not have one.
 *    Bills carry VAT as rate + amount, and input-VAT treatment is decided by
 *    the categoriser and `vat_basis`, not by a line code.
 *
 * 3. **The matching vocabulary is BILLING, never delivery.** See
 *    `purchase_order_conversions`.
 */
import { pgTable, serial, text, timestamp, integer, numeric, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { vendorsTable } from "./vendors";
import { productsTable } from "./products";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const purchaseOrdersTable = pgTable(
  "purchase_orders",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),

    /** `PO-{YYYY}-{NNNN}`, server-allocated; the unique index is the guarantee. */
    orderNumber: text("order_number").notNull(),
    vendorId: integer("vendor_id").references(() => vendorsTable.id, { onDelete: "restrict" }),
    date: text("date").notNull(),
    /** When the order lapses if the supplier has not acted. NULL = not stated. */
    validUntil: text("valid_until"),

    /** APPROVAL axis only: draft | submitted | approved. */
    status: text("status").notNull().default("draft"),
    /**
     * Terminal act by the TENANT: `cancelled` (the order was withdrawn) or
     * `closed` (the remainder is abandoned — the supplier will not bill it).
     * NULL = live.
     *
     * 🔴 The vocabulary differs from a quotation's on purpose. A quotation is
     * DECLINED by the customer; a purchase order is CANCELLED by us. Reusing
     * "declined" would say the supplier refused, which is a different fact and
     * one we have no way to know.
     */
    outcome: text("outcome"),

    subtotal: numeric("subtotal", { precision: 15, scale: 2 }).notNull().default("0"),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
    currency: text("currency").default("SAR"),

    reviewNote: text("review_note"),
    notes: text("notes"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("purchase_orders_org_status_idx").on(t.organizationId, t.status),
    index("purchase_orders_vendor_idx").on(t.vendorId),
    uniqueIndex("purchase_orders_company_number_unq").on(t.companyId, t.orderNumber),
  ],
);

export const purchaseOrderItemsTable = pgTable(
  "purchase_order_items",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),
    purchaseOrderId: integer("purchase_order_id")
      .notNull()
      .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
    productId: integer("product_id").references(() => productsTable.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    descriptionAr: text("description_ar").notNull().default("(not yet translated)"),
    quantity: numeric("quantity", { precision: 15, scale: 3 }).notNull().default("1"),
    /**
     * The price we ORDERED at. Conversion pre-fills the bill with it, but —
     * unlike a quotation, where the quoted price binds us — the supplier's
     * bill may legitimately say something else. The bill is the truth; this
     * stays as the expectation, and the difference is recorded as a variance.
     */
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).default("15"),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).default("0"),
    total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
    unitCode: text("unit_code").notNull().default("PCE"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("purchase_order_items_org_order_idx").on(t.organizationId, t.purchaseOrderId)],
);

/**
 * A conversion event — one row each time part or all of a PO becomes a bill.
 *
 * 🔴 THE VOCABULARY IS BILLING, NEVER DELIVERY (owner instruction).
 *
 * A three-way match (PO / goods receipt / invoice) is not possible here: the
 * platform has no goods-receipt concept, so this is a TWO-WAY match, PO ↔
 * bill. That means we cannot distinguish "the supplier shipped half" from
 * "the supplier billed half" — and:
 *
 *   > pretending otherwise would be a confident wrong answer
 *
 * So this column is `billed_on`, not `received_on`; the derived state says
 * "partially billed", not "partially received"; and the remaining quantity is
 * UN-BILLED, not outstanding. Nothing in this feature may claim knowledge of
 * goods movement, because it has none.
 *
 * Append-only at the grants, like the quotation side and `invoice_payments`.
 */
export const purchaseOrderConversionsTable = pgTable(
  "purchase_order_conversions",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),
    purchaseOrderId: integer("purchase_order_id")
      .notNull()
      .references(() => purchaseOrdersTable.id, { onDelete: "restrict" }),
    /** The bill this produced — a real FK, not the bill number string. */
    billId: integer("bill_id").notNull(),
    /** The date the SUPPLIER'S BILL is dated. Not a delivery date. */
    billedOn: text("billed_on").notNull(),
    convertedBy: integer("converted_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("purchase_order_conversions_order_idx").on(t.purchaseOrderId),
    index("purchase_order_conversions_bill_idx").on(t.billId),
  ],
);

export const purchaseOrderConversionItemsTable = pgTable(
  "purchase_order_conversion_items",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),
    conversionId: integer("conversion_id")
      .notNull()
      .references(() => purchaseOrderConversionsTable.id, { onDelete: "cascade" }),
    purchaseOrderItemId: integer("purchase_order_item_id")
      .notNull()
      .references(() => purchaseOrderItemsTable.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 15, scale: 3 }).notNull(),
    /**
     * 🔴 The price the supplier ACTUALLY billed, stored per event.
     *
     * This is what makes a price variance a recorded fact rather than a
     * recomputation: the ordered price lives on the PO line, the billed price
     * lives here, and the difference is derived from the two. Storing only the
     * bill's total would lose which line moved, and recomputing from the bill
     * later would break the moment the bill is edited.
     */
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("purchase_order_conversion_items_conversion_idx").on(t.conversionId)],
);

export const insertPurchaseOrderSchema = createInsertSchema(purchaseOrdersTable).omit({ id: true, createdAt: true });
export type PurchaseOrder = typeof purchaseOrdersTable.$inferSelect;
export type PurchaseOrderItem = typeof purchaseOrderItemsTable.$inferSelect;
export type PurchaseOrderConversion = typeof purchaseOrderConversionsTable.$inferSelect;
export type InsertPurchaseOrder = z.infer<typeof insertPurchaseOrderSchema>;
