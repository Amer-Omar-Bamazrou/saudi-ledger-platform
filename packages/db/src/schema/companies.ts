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
  /**
   * Saudi National Address "additional number" (4 digits) — M12.2.
   *
   * Required by **BR-KSA-09**: "Seller address must contain additional number
   * (KSA-23), street name (BT-35), building number (KSA-17), postal code
   * (BT-38), city (BT-37), Neighborhood (KSA-3), country code (BT-40)." Missed
   * by M11.6/M12.1a — a STANDARD tax invoice cannot pass validation without it.
   * Maps to `cbc:PlotIdentification` in the UBL seller PostalAddress.
   */
  additionalNumber: varchar("additional_number", { length: 10 }),

  // ── ZATCA Phase 2 EGS identity (M12.1a) ────────────────────────────────────
  /**
   * EGS (E-invoice Generation Solution) unit serial number, in ZATCA's validated
   * format `1-<Manufacturer>|2-<Model>|3-<Serial>`. One EGS unit — and therefore
   * one certificate, one PIH chain and one ICV counter — per company.
   * Minted during onboarding (M12.5).
   */
  egsSerialNumber: varchar("egs_serial_number", { length: 255 }),
  /**
   * not_started | csr_generated | compliance_csid | onboarded | failed
   * Certificates and key material are NOT stored here — they live in the
   * owner-only encrypted vault added in M12.5.
   */
  zatcaOnboardingStatus: varchar("zatca_onboarding_status", { length: 50 })
    .notNull()
    .default("not_started"),

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
