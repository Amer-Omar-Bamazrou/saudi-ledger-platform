import { pgTable, serial, text, boolean, timestamp, integer, numeric, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { productsTable } from "./products";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const invoicesTable = pgTable(
  "invoices",
  {
    id: serial("id").primaryKey(),
    // Multi-tenancy — enforced NOT NULL in M3 (migrations/0002).
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),
    invoiceNumber: text("invoice_number").notNull(),
    date: text("date").notNull(),
    dueDate: text("due_date"),
    customerId: integer("customer_id").references(() => customersTable.id, { onDelete: "restrict" }),
    // Draft/approval workflow (M10.4): draft = editable, not in AR/VAT, and NOT
    // yet in the ZATCA hash chain (invoice_hash is null until approved, so a
    // rejected/deleted draft never consumes a sequence number); submitted =
    // awaiting approval (locked); sent = approved & issued (hashed + AR posted).
    status: text("status").notNull().default("draft"), // draft | submitted | sent | paid | overdue | cancelled
    subtotal: numeric("subtotal", { precision: 15, scale: 2 }).notNull().default("0"),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    discount: numeric("discount", { precision: 15, scale: 2 }).default("0"),
    total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
    currency: text("currency").default("SAR"),
    paidAmount: numeric("paid_amount", { precision: 15, scale: 2 }).default("0"),
    paidAt: text("paid_at"),
    // Correction note an approver leaves when sending a submitted invoice back to
    // the enterer; shown while editing, cleared on resubmit/approve (M10.4).
    reviewNote: text("review_note"),
    notes: text("notes"),
    termsAndConditions: text("terms_and_conditions"),
    createdBy: integer("created_by"),    // FK to users.id (nullable for pre-auth records)
    // ── ZATCA PHASE 1 fields (legacy) ────────────────────────────────────────
    // WARNING: `invoiceHash`/`previousHash` are the HOMEGROWN chain (hex SHA-256
    // of a pipe-joined field list), NOT ZATCA's. ZATCA's is base64 SHA-256 of the
    // canonicalised UBL XML and lives in `einvoice_documents` (M12.1a) once
    // M12.3 lands. These columns are retained for pre-ZATCA legacy invoices; do
    // NOT extend them. See CLAUDE.md "LANDMINE".
    invoiceHash: text("invoice_hash"),   // legacy homegrown hash — not ZATCA's
    previousHash: text("previous_hash"), // legacy homegrown chain link
    qrCode: text("qr_code"),            // Base64 TLV QR, ZATCA Phase 1 tags 1-5 only
    sellerName: text("seller_name"),     // Denormalized for QR (changes over time)
    sellerVatNumber: text("seller_vat_number"), // Denormalized for QR

    // ── ZATCA PHASE 2 identity (M12.1a) ──────────────────────────────────────
    // Identity of the document itself, as opposed to transmission state (which
    // lives in `einvoice_documents`). All nullable: existing invoices predate
    // ZATCA onboarding and are deliberately NOT backfilled — the ZATCA chain
    // starts fresh at first onboarding, so a legacy invoice has no UUID/ICV.
    /** ZATCA-required 128-bit UUID, one per document. */
    zatcaUuid: uuid("zatca_uuid"),
    /**
     * Invoice Counter Value. Strictly sequential and NEVER reused, scoped per
     * EGS unit — i.e. per COMPANY, not per organization. Enforced by the unique
     * index below; the chain is company-scoped for the same reason (M12.1a bug
     * fix: a multi-company org previously interleaved chains).
     */
    icv: integer("icv"),
    /**
     * Actual issuance timestamp. DISTINCT from `date`, which is the accounting
     * date the ledger and reports use. ZATCA needs date+time, and the 24-hour
     * simplified-invoice reporting clock runs off this.
     */
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    /** invoice | credit_note | debit_note (M12.1b). */
    documentType: text("document_type").notNull().default("invoice"),

    /**
     * The document this note corrects (M12.1b) — a REAL FK, not the invoice
     * number string.
     *
     * ZATCA's `cac:BillingReference` carries the original's NUMBER, but that is
     * derived from this row at assembly time. Storing the string instead would
     * let the reference drift from the row it names, and would not let us check
     * that the original is actually issued or how much has already been credited.
     *
     * A CHECK constraint (hand-written in migration 0020 — Drizzle cannot
     * express it) makes this NULL for ordinary invoices and NOT NULL for notes,
     * so the pairing cannot be wrong by construction.
     */
    originalInvoiceId: integer("original_invoice_id"),

    /**
     * Why the note was issued — **BR-KSA-17** requires it (KSA-10) on every
     * credit and debit note. Emitted as `cbc:InstructionNote`.
     *
     * Also covered by the CHECK constraint: without it ZATCA rejects the
     * document, so it is required at entry rather than discovered at submission.
     */
    noteReason: text("note_reason"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("invoices_org_status_idx").on(t.organizationId, t.status),
    // Notes-for-an-original lookups: the over-crediting guard sums every note
    // against one invoice on each note approval.
    index("invoices_original_idx").on(t.originalInvoiceId),
    // ICV must be unique per company — the DB is the real guarantee against a
    // reused counter value under concurrent approvals.
    uniqueIndex("invoices_company_icv_unq").on(t.companyId, t.icv),
  ],
);

export const invoiceItemsTable = pgTable(
  "invoice_items",
  {
    id: serial("id").primaryKey(),
    // Multi-tenancy — enforced NOT NULL in M3 (migrations/0002).
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),
    invoiceId: integer("invoice_id").notNull().references(() => invoicesTable.id, { onDelete: "cascade" }),
    productId: integer("product_id").references(() => productsTable.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    descriptionAr: text("description_ar").notNull().default("(not yet translated)"),
    quantity: numeric("quantity", { precision: 15, scale: 3 }).notNull().default("1"),
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).default("15"),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).default("0"),
    discount: numeric("discount", { precision: 15, scale: 2 }).default("0"),
    total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),

    // ── ZATCA PHASE 2 line-level tax classification (M12.1a) ─────────────────
    /**
     * UN/CEFACT 5305 tax category. ZATCA uses:
     *   S = standard rate · Z = zero-rated · E = exempt · O = out of scope
     *
     * NULLABLE ON PURPOSE. The 0%-rate backfill is genuinely ambiguous — a
     * `vat_rate = 0` line could be zero-rated (Z) OR exempt (E), and the two are
     * different tax treatments the existing data does not distinguish. The
     * migration backfills only the unambiguous case (15% → 'S') and leaves 0%
     * lines NULL, so issuance FAILS CLOSED demanding an explicit category rather
     * than guessing a tax fact. Same principle as M11.6's seller VAT number.
     */
    taxCategoryCode: text("tax_category_code"),
    /** Required by ZATCA whenever the category is Z, E or O. */
    taxExemptionReasonCode: text("tax_exemption_reason_code"),
    taxExemptionReasonText: text("tax_exemption_reason_text"),
    /** UN/ECE Rec 20 unit of measure. 'PCE' (piece) is the safe default. */
    unitCode: text("unit_code").notNull().default("PCE"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("invoice_items_org_invoice_idx").on(t.organizationId, t.invoiceId)],
);

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({ id: true, createdAt: true });
export const insertInvoiceItemSchema = createInsertSchema(invoiceItemsTable).omit({ id: true, createdAt: true });
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
export type InvoiceItem = typeof invoiceItemsTable.$inferSelect;
