import { pgTable, serial, text, boolean, timestamp, uuid, index, uniqueIndex, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { WHT_PAYMENT_TYPES_SQL } from "./whtTypes";

export const vendorsTable = pgTable(
  "vendors",
  {
    id: serial("id").primaryKey(),
    // Multi-tenancy — enforced NOT NULL in M3 (migrations/0002).
    // Master data scoped to the organization; company_id omitted for now.
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    name: text("name").notNull(),
    nameAr: text("name_ar"),
    taxNumber: text("tax_number"),       // VAT registration / ZATCA number
    crNumber: text("cr_number"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    city: text("city"),
    country: text("country").default("SA"),
    currency: text("currency").default("SAR"),
    iban: text("iban"),
    paymentTermsDays: text("payment_terms_days").default("30"),
    notes: text("notes"),
    /**
     * B8 (Phase 11 Part 2, 2026-09-22) — WITHHOLDING TAX, FOUNDATION ONLY.
     * `resident` | `non_resident` | `unknown`.
     *
     * 🔴 THIS IS A FACT ABOUT THE SUPPLIER, NOT A TAX RULE, and that boundary
     * is the whole of what this batch builds. Income Tax Law Art. 68 makes a
     * resident payer withhold on amounts paid to a NON-RESIDENT from a source
     * in the Kingdom — so residency is the input every WHT question starts
     * from, and recording it now costs nothing and is not a judgment.
     *
     * Phase 16 (2026-10-04) BUILT WHT on this fact: a payment to a
     * `non_resident` withholds at the pay paths (services/tax/wht.ts) at the
     * rate the regulation fixes for the payment's DECLARED nature — the
     * platform never guesses the nature (pack §2.3).
     *
     * `unknown` is FIRST-CLASS and is the default: a supplier nobody has
     * classified must read as unclassified, never as resident, because
     * "resident" is the answer that withholds nothing. A payment to an
     * `unknown` supplier withholds nothing and is LISTED as a WHT exception.
     */
    residency: text("residency").notNull().default("unknown"),
    /**
     * Phase 16 — the supplier's DECLARED default WHT nature (one of
     * WHT_PAYMENT_TYPES), set by a person and shown, changeable, in the pay
     * dialog. NULL = none declared: a payment to a non-resident then has to
     * state its nature or it is refused (`wht_classification_required`).
     */
    whtDefaultPaymentType: text("wht_default_payment_type"),
    /** Phase 16 — the beneficiary's registration number abroad (Income Tax Law Art. 68(B)(3)). */
    foreignTaxId: text("foreign_tax_id"),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Batch 1C (2026-09-19) — the PROVENANCE of a migrated record: which
     * source-system party this row represents, as (source_system, source_id).
     * NULL for a record the platform created itself. Unique per organisation
     * as a pair (master data is organisation-scoped), so a re-import of the
     * same source id resolves to THIS row instead of creating a second one —
     * deterministic identity, never a name match. Written at migration commit;
     * never edited afterwards.
     */
    sourceSystem: text("source_system"),
    sourceId: text("source_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("vendors_org_idx").on(t.organizationId),
    check("vendors_residency_chk", sql`residency IN ('resident', 'non_resident', 'unknown')`),
    check("vendors_wht_default_type_chk", sql`wht_default_payment_type IS NULL OR wht_default_payment_type IN (${WHT_PAYMENT_TYPES_SQL})`),
    uniqueIndex("vendors_source_identity_unq").on(t.organizationId, t.sourceSystem, t.sourceId).where(sql`source_system IS NOT NULL`),
    // 🔴 G04 (0122): the TARGET of a tenant-keyed foreign key — a reference to
    // this row carries the organization, so another tenant's id cannot be named.
    unique("vendors_org_id_unq").on(t.organizationId, t.id),
  ],
);

export const insertVendorSchema = createInsertSchema(vendorsTable).omit({ id: true, createdAt: true });
export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type Vendor = typeof vendorsTable.$inferSelect;
