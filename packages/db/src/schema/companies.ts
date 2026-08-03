import { pgTable, uuid, varchar, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

/**
 * Companies — a legal entity within an organization. VAT registration, Zakat
 * filing, chart of accounts and financial statements are produced per company.
 * A company always belongs to exactly one organization.
 *
 * Added in Milestone 2 (additive). Not yet enforced on business tables.
 */
export const companiesTable = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  name: varchar("name", { length: 255 }).notNull(),
  /** Arabic legal name — printed on invoices; required for ZATCA Phase 2. */
  nameAr: varchar("name_ar", { length: 255 }),
  crNumber: varchar("cr_number", { length: 50 }), // Saudi commercial registration number
  vatNumber: varchar("vat_number", { length: 50 }), // ZATCA VAT registration
  fiscalYearStart: integer("fiscal_year_start").notNull().default(1), // month number (1-12)

  // ── Seller national short address (M11.6) ──────────────────────────────────
  // Nullable: NOT required by the ZATCA Phase-1 QR (tags 1-5) or the invoice
  // hash, so they do not gate issuance today. Added now because ZATCA Phase 2
  // (standard tax invoices) requires the seller address, and they already appear
  // on printed invoices — storing them here avoids a second migration later.
  buildingNumber: varchar("building_number", { length: 10 }),
  street: varchar("street", { length: 255 }),
  district: varchar("district", { length: 255 }),
  city: varchar("city", { length: 100 }),
  postalCode: varchar("postal_code", { length: 10 }),

  status: varchar("status", { length: 50 }).notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
