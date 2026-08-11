import { pgTable, serial, text, boolean, timestamp, uuid, index } from "drizzle-orm/pg-core";
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
    nameAr: text("name_ar").notNull().default("(not yet translated)"),
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
     * `companies.additional_number` (M12.2). Not itself required by BR-KSA-10;
     * carried for completeness when the buyer supplies a full national address.
     */
    additionalNumber: text("additional_number"),
    /**
     * Country subentity / province (`cbc:CountrySubentity`, BT-54) — M12.2.
     *
     * **REQUIRED for STANDARD (B2B) invoices by BR-KSA-10**, which is a
     * *hard error*. Its human-readable message lists only "street (BT-50), city
     * (BT-52), postal code (BT-53), country code (BT-55)" — but the actual
     * schematron ALSO asserts `cbc:CountrySubentity` and
     * `cbc:CitySubdivisionName`. Found by running ZATCA's own validator; the
     * message alone would have sent you looking in the wrong place.
     * Not required on the seller (BR-KSA-09 omits it, and is only a warning).
     */
    province: text("province"),
    currency: text("currency").default("SAR"),
    creditLimit: text("credit_limit"),    // numeric stored as text
    paymentTermsDays: text("payment_terms_days").default("30"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("customers_org_idx").on(t.organizationId)],
);

export const insertCustomerSchema = createInsertSchema(customersTable).omit({ id: true, createdAt: true });
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type Customer = typeof customersTable.$inferSelect;
