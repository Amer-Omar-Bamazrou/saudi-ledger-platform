import { pgTable, text, timestamp, integer, uuid, index, uniqueIndex, jsonb, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { invoicesTable } from "./invoices";

/**
 * ZATCA Phase 2 e-invoice document — the XML artifacts and TRANSMISSION state
 * for one invoice (M12.1a).
 *
 * ── Why this is a separate table from `invoices` ────────────────────────────
 * The split is identity vs transmission:
 *
 *   `invoices`            identity — uuid, icv, issued_at, document_type.
 *                         Immutable once issued; read by the accounting core.
 *   `einvoice_documents`  the signed/cleared XML and the submission lifecycle.
 *                         M12.6 churns this row hard (retries, backoff, status
 *                         transitions) and it carries large XML blobs — neither
 *                         belongs on the hot invoice row the ledger reads.
 *
 * It is also where M12.6's outbox lives: a row committed with the approval, then
 * picked up by a worker OUTSIDE the request transaction (a synchronous ZATCA
 * call cannot run inside it — see CLAUDE.md M12.6).
 *
 * ── Tenant-scoped, not owner-only ───────────────────────────────────────────
 * Unlike the M12.5 credential vault, this is ordinary business data: RLS +
 * app-role grants, exactly like `invoices`. The tenant must be able to read
 * their own cleared XML (they are legally required to retain it).
 */
export const einvoiceDocumentsTable = pgTable(
  "einvoice_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Multi-tenancy. NOTE: the older business tables still *declare*
    // `app_default_org_id()` here, but M4 dropped those functions and swapped the
    // real DB defaults to the request tenant GUCs — the schema files are known to
    // drift. New tables declare the ACTUAL M4 default, so `generate` emits
    // working DDL. No tenant context ⇒ NULL ⇒ NOT NULL rejects the write.
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    /** One document per invoice (enforced unique below). */
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "cascade" }),

    // ── ZATCA flow ───────────────────────────────────────────────────────────
    /**
     * clearance — STANDARD (B2B/B2G): submitted BEFORE issuance; the invoice is
     *             not legally valid until ZATCA returns it stamped.
     * reporting — SIMPLIFIED (B2C): stamped locally by us, reported within 24h.
     */
    flow: text("flow").notNull(),
    /**
     * pending → submitted → cleared | reported | rejected | failed
     *   pending    queued, not yet sent (the outbox state)
     *   submitted  in flight to ZATCA
     *   cleared    ZATCA accepted and stamped (clearance flow)
     *   reported   ZATCA accepted (reporting flow)
     *   rejected   ZATCA rejected it — business/validation failure, do not retry
     *   failed     transport failure — retryable
     */
    status: text("status").notNull().default("pending"),

    // ── Cryptographic artifacts (populated in M12.3) ─────────────────────────
    /**
     * ZATCA's invoice hash: BASE64( SHA-256( C14N-canonicalised UBL XML ) ).
     * NOT the legacy hex hash on `invoices.invoice_hash`.
     */
    invoiceHash: text("invoice_hash"),
    /**
     * Previous Invoice Hash. Chained per COMPANY (per EGS unit), not per
     * organization. The first document in a chain uses ZATCA's genesis PIH
     * (base64 of the hex string of SHA-256("0")), shipped in the SDK.
     */
    previousInvoiceHash: text("previous_invoice_hash"),
    /** Phase 2 QR — TLV tags 1-9, base64. (`invoices.qr_code` is Phase 1, 1-5.) */
    qrCode: text("qr_code"),
    /** The XAdES-signed UBL 2.1 document we submitted. */
    signedXml: text("signed_xml"),
    /** ZATCA's stamped XML returned by clearance — the legal document. */
    clearedXml: text("cleared_xml"),

    // ── Submission lifecycle ─────────────────────────────────────────────────
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Retry accounting for the M12.6 worker. */
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),

    // ── Worker claiming (M12.6) ──────────────────────────────────────────────
    /**
     * Set when a worker claims the row via `FOR UPDATE SKIP LOCKED`. A row stuck
     * in `submitting` with an old `claimed_at` means the worker died mid-flight;
     * the sweeper reclaims it — but ONLY through the query-then-decide
     * reconciliation path, never by blind resubmission.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    /**
     * TRUE when a submission failed in a way that leaves ZATCA's state UNKNOWN
     * (timeout, connection reset) — i.e. they may or may not have received it.
     *
     * This is the flag that makes blind retry unsafe: resubmitting a document
     * ZATCA already accepted risks a duplicate, and abandoning one they never
     * received strands a consumed ICV. Such rows must be reconciled by ASKING
     * ZATCA, not by guessing.
     */
    ambiguous: boolean("ambiguous").notNull().default(false),
    /** ZATCA's own status string, verbatim (e.g. reported/cleared variants). */
    zatcaStatus: text("zatca_status"),
    /** ZATCA validation warnings — accepted, but worth surfacing to the user. */
    zatcaWarnings: jsonb("zatca_warnings"),
    /** ZATCA validation errors, or the transport error on a failed attempt. */
    lastError: jsonb("last_error"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("einvoice_documents_invoice_unq").on(t.invoiceId),
    index("einvoice_documents_org_status_idx").on(t.organizationId, t.status),
    // The M12.6 worker's claim query: due work, oldest first.
    index("einvoice_documents_due_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const insertEinvoiceDocumentSchema = createInsertSchema(einvoiceDocumentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEinvoiceDocument = z.infer<typeof insertEinvoiceDocumentSchema>;
export type EinvoiceDocument = typeof einvoiceDocumentsTable.$inferSelect;
