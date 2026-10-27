/**
 * 🔴 Phase 18 — the PR C correction route (owner decision 2 of 2026-10-27): a
 * ZATCA rejection of an invoice's submission, recorded by an approver with
 * ZATCA's response attached, until the live response mapping exists.
 *
 * APPEND-ONLY for EVERY role (migration 0134, the T1b pattern): the response
 * and the reason are the evidence the rejected document is preserved with.
 * Recording one changes nothing on the invoice or its entry; the invoice is
 * corrected by a NEW invoice that names it (`invoices.corrects_invoice_id`).
 *
 * No tenant→tenant foreign key (the G04 ratchet): the writer proves the invoice
 * is its own, and the database checks the invoice is in the row's organisation
 * and company at insert (0134).
 */
import { pgTable, serial, text, timestamp, integer, uuid, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const invoiceRejectionsTable = pgTable(
  "invoice_rejections",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id").notNull().default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`).references(() => organizationsTable.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`).references(() => companiesTable.id, { onDelete: "cascade" }),
    invoiceId: integer("invoice_id").notNull(),
    /** The submission ZATCA answered (`einvoice_documents.id`). */
    einvoiceDocumentId: uuid("einvoice_document_id"),
    /** ZATCA's response, verbatim. */
    zatcaResponse: text("zatca_response").notNull(),
    reason: text("reason").notNull(),
    /** When ZATCA rejected it, as ZATCA reported it (decision 2's separate "rejection" field). */
    zatcaRejectedAt: timestamp("zatca_rejected_at", { withTimezone: true }),
    recordedBy: integer("recorded_by"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("invoice_rejections_invoice_unq").on(t.invoiceId),
    check("invoice_rejections_evidence_chk", sql`length(btrim(${t.zatcaResponse})) > 0 and length(btrim(${t.reason})) > 0`),
  ],
);

export type InvoiceRejection = typeof invoiceRejectionsTable.$inferSelect;
