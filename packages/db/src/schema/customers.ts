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
