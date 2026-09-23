import { pgTable, serial, text, boolean, timestamp, uuid, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

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
     * 🔴 WHAT IS DELIBERATELY NOT BUILT: no rate, no automatic withholding, no
     * deduction at payment, no Form-Q filing. The By-Laws set DIFFERENT rates
     * by the NATURE of the payment (rent, technical and consulting services,
     * royalties, management fees, and so on), and classifying a payment's
     * nature is an accounting judgment this platform must not guess — the
     * escalation protocol sends it to the accountant, and the board has WHT
     * awaiting the owner's ranking. `WHT_PAYABLE` and this column are the
     * structure those answers will land in; until they do, nothing withholds.
     *
     * `unknown` is FIRST-CLASS and is the default: a supplier nobody has
     * classified must read as unclassified, never as resident, because
     * "resident" is the answer that withholds nothing.
     */
    residency: text("residency").notNull().default("unknown"),
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
    uniqueIndex("vendors_source_identity_unq").on(t.organizationId, t.sourceSystem, t.sourceId).where(sql`source_system IS NOT NULL`),
  ],
);

export const insertVendorSchema = createInsertSchema(vendorsTable).omit({ id: true, createdAt: true });
export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type Vendor = typeof vendorsTable.$inferSelect;
