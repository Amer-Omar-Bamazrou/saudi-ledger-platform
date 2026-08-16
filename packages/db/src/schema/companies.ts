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
  /**
   * Month the fiscal year starts, 1–12 **in `fiscalCalendar`** (M17.2).
   *
   * 🔴 Its meaning depends on the column below: under `gregorian` 1 = January,
   * under `hijri` 1 = Muharram. Read them together, always.
   *
   * Stored since M11.6 and applied by NOTHING until M17.2 — the Company
   * Settings page said so out loud. It is now resolved by
   * `lib/fiscalYear.ts` and surfaced per company.
   */
  /**
     * M20.0 — NULLABLE WITH NO DEFAULT (F8/F10). NULL = the tenant has not
     * declared a fiscal year, and that is a first-class state: the old
     * `NOT NULL DEFAULT 1` recorded every untouched company as having chosen
     * January, which is the schema speaking for the tenant (the M17.1
     * `ownership_type` lesson). Reports fall back to a rolling last-12-months
     * while NULL, saying so (F11). Month 1–12 IN `fiscal_calendar`.
     */
    fiscalYearStart: integer("fiscal_year_start"),
  /**
   * Which calendar the fiscal year is expressed in — `gregorian` | `hijri`
   * (M17.2, owner decision Q3: both are supported, and robust fiscal-year
   * support is a prerequisite for the Zakat working paper).
   *
   * Defaults to `gregorian`, which is what every existing tenant effectively
   * had: it is the only behaviour the platform has ever implemented, so the
   * default preserves it rather than silently re-dating anyone's year.
   *
   * `hijri` means the **Umm al-Qura** calendar specifically — the Saudi civil
   * calendar. ICU offers three other islamic calendars that disagree by a day
   * or two; see `lib/hijriCalendar.ts`.
   */
  fiscalCalendar: varchar("fiscal_calendar", { length: 20 }).notNull().default("gregorian"),
  /**
   * Ownership structure — `SAUDI_GCC` | `FOREIGN` | `MIXED` (M17.1, owner
   * decision Q2). Read by the Zakat scope gate: v1 covers 100% Saudi/GCC-owned
   * entities, and foreign/mixed companies are directed to a tax advisor rather
   * than given an approximation.
   *
   * 🔴 NULL = NOT DECLARED, and that is a first-class state. There is no
   * default on purpose: defaulting to `SAUDI_GCC` would make the PLATFORM
   * assert a fact about the TENANT's ownership that nobody supplied, and that
   * assertion decides whether a Zakat surface is shown at all. An undeclared
   * company is ASKED; it is never assumed to qualify.
   *
   * Scope: v1 reads this for the Zakat gate ONLY. Ownership has consequences
   * beyond Zakat (income tax most obviously) — do not treat this as a general
   * tax-status field until something actually establishes it as one.
   */
  ownershipType: varchar("ownership_type", { length: 20 }),

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
  //
  // 🔴 `zatca_onboarding_status` was REMOVED in M12.8 (migration 0022).
  //
  // It was declared in M12.1a and NEVER WRITTEN by any code — a search across
  // apps/, packages/db/src/ and scripts/ found exactly one reference, this
  // declaration. Every row therefore read 'not_started' for its whole life, so
  // any view trusting it would report that no company had ever onboarded.
  //
  // The real onboarding state is `zatca_credentials.status`
  // (pending_csr → active → superseded | revoked), which M12.4 maintains and
  // which M12.8's operator view derives from. A column nothing writes is worse
  // than no column: it reads as authoritative. Do not reintroduce it — two
  // sources of truth for one fact is precisely how the M11.6 production blocker
  // happened.

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
