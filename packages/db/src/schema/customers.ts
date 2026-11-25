import { pgTable, serial, text, boolean, timestamp, uuid, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const customersTable = pgTable(
  "customers",
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
    crNumber: text("cr_number"),          // Commercial Registration
    /**
     * Buyer national ID (BT-46, scheme NAT) — M12.1b.
     *
     * Required only for the exemption codes `VATEX-SA-EDU` and `VATEX-SA-HEA`:
     * ZATCA's **BR-KSA-49** makes the buyer's national ID mandatory whenever one
     * of those is used, and **BR-KSA-25** additionally requires the buyer name.
     * Found by submitting such an invoice to the live compliance API in M12.4
     * and reading the rejection.
     *
     * Nullable — the overwhelming majority of customers never need it.
     */
    nationalId: text("national_id"),
    phone: text("phone"),
    email: text("email"),
    /** Free-text address — retained for display and back-compat. */
    address: text("address"),
    city: text("city"),
    country: text("country").default("SA"),

    // ── Buyer national short address (M12.1a) ────────────────────────────────
    // ZATCA STANDARD (B2B) tax invoices require a STRUCTURED buyer address; the
    // free-text `address` above cannot satisfy it. Nullable because simplified
    // (B2C) invoices do not require a buyer address at all — issuance validates
    // per document type rather than the schema forcing it on every customer.
    buildingNumber: text("building_number"),
    street: text("street"),
    district: text("district"),
    postalCode: text("postal_code"),
    /**
     * Saudi National Address "additional number" — the buyer-side mirror of
     * `companies.additional_number` (M12.2). Not required; if present it must be
     * 4 digits (KSA-19, the pinned XML standard) — `buyer_address_incomplete`.
     */
    additionalNumber: text("additional_number"),
    /**
     * Country subentity / province (`cbc:CountrySubentity`, BT-54) — M12.2.
     *
     * Status (2026-11-25): NOT required by ZATCA's live sandbox. Evidence (LIVE,
     * 2026-11-24, `customer-form-standard-invoice-live.test.ts`): a standard
     * invoice to a Saudi buyer is checked by BR-KSA-63 (street, building number,
     * postal code, city, district, country — no province) and BR-KSA-67 (postal
     * code 5 digits); BR-KSA-10 now applies to a buyer OUTSIDE Saudi Arabia
     * (street, city, country). The sandbox returned all of them as warnings, and
     * an invoice whose buyer had the full national address and NO province
     * PASSED with no warning. An earlier SDK run (M12.2) had read BR-KSA-10 as a
     * hard error asserting the province; the live API outranks the SDK. What the
     * platform requires before approval is `buyer_address_incomplete`
     * (apps/api/src/services/einvoice/buyerAddress.ts). Kept, optional, and
     * carried in the XML (BT-54) when present.
     */
    province: text("province"),
    currency: text("currency").default("SAR"),
    creditLimit: text("credit_limit"),    // numeric stored as text
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
    index("customers_org_idx").on(t.organizationId),
    uniqueIndex("customers_source_identity_unq").on(t.organizationId, t.sourceSystem, t.sourceId).where(sql`source_system IS NOT NULL`),
    // 🔴 G04 (0122): the TARGET of a tenant-keyed foreign key — a reference to
    // this row carries the organization, so another tenant's id cannot be named.
    unique("customers_org_id_unq").on(t.organizationId, t.id),
  ],
);

export const insertCustomerSchema = createInsertSchema(customersTable).omit({ id: true, createdAt: true });
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type Customer = typeof customersTable.$inferSelect;
