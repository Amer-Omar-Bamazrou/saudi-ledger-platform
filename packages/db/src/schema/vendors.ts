import { pgTable, serial, text, boolean, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
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
    uniqueIndex("vendors_source_identity_unq").on(t.organizationId, t.sourceSystem, t.sourceId).where(sql`source_system IS NOT NULL`),
  ],
);

export const insertVendorSchema = createInsertSchema(vendorsTable).omit({ id: true, createdAt: true });
export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type Vendor = typeof vendorsTable.$inferSelect;
