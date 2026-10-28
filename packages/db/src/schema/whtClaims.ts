/**
 * 🔴 Phase 18 G4b — WHT owner decisions 17 and 18 (2026-10-27; register §11.43).
 * RECORDS ONLY, append-only for the request's role (0140 grants SELECT and
 * INSERT): nothing here posts, refunds, offsets, reverses or waives anything.
 *
 *  - 17: an over-withheld amount is pursued by a REFUND CLAIM with an evidence
 *    checklist and a five-year clock (Income Tax Law Art. 65(c)); its life is
 *    append-only EVENTS (evidence updated, submitted, refunded, refused).
 *  - 18: an instalment plan under Resolution 1117 is a REQUEST for WHT months
 *    whose returns fell due before 1 July 2026; it counts only once ZATCA's
 *    WRITTEN acceptance is recorded as an event.
 *
 * The supplier a claim names is checked by the service (no tenant→tenant key to
 * vendors, the T1e convention); each event names its claim or request with a
 * key that carries `organization_id` (the G04 rule).
 */
import { pgTable, serial, text, timestamp, integer, uuid, date, check, numeric, jsonb, unique, foreignKey, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

const tenant = () => ({
  organizationId: uuid("organization_id").notNull().default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`).references(() => organizationsTable.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`).references(() => companiesTable.id, { onDelete: "cascade" }),
});

/** The six items of decision 17's evidence checklist, in its order. */
export const WHT_REFUND_CHECKLIST_ITEMS = [
  "contractAndInvoice", "correctCategoryAndRate", "originalStatementAndReceipt", "reconciliation", "whoBoreTheExcess", "beneficiaryAuthorisation",
] as const;

export const whtRefundClaimsTable = pgTable(
  "wht_refund_claims",
  {
    id: serial("id").primaryKey(),
    ...tenant(),
    /** The WHT month the excess was withheld in (YYYY-MM). */
    period: text("period").notNull(),
    /** The beneficiary (supplier) the excess was withheld from — checked by the service. */
    vendorId: integer("vendor_id").notNull(),
    overpaidTaxYear: integer("overpaid_tax_year").notNull(),
    excessAmount: numeric("excess_amount", { precision: 15, scale: 2 }).notNull(),
    /** payer | beneficiary — who bore the excess (checklist item 5's fact). */
    borneBy: text("borne_by").notNull(),
    reason: text("reason").notNull(),
    /** {item: {held, note}} for the six WHT_REFUND_CHECKLIST_ITEMS, as recorded with the claim. */
    checklist: jsonb("checklist").notNull(),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("wht_refund_claims_org_id_unq").on(t.organizationId, t.id),
    index("wht_refund_claims_company_idx").on(t.companyId, t.period),
    check("wht_refund_claims_period_chk", sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("wht_refund_claims_year_chk", sql`${t.overpaidTaxYear} between 2000 and 2100`),
    check("wht_refund_claims_excess_chk", sql`${t.excessAmount} > 0`),
    check("wht_refund_claims_borne_chk", sql`${t.borneBy} in ('payer', 'beneficiary')`),
    check("wht_refund_claims_reason_chk", sql`length(btrim(${t.reason})) > 0`),
  ],
);

export const whtRefundClaimEventsTable = pgTable(
  "wht_refund_claim_events",
  {
    id: serial("id").primaryKey(),
    ...tenant(),
    claimId: integer("claim_id").notNull(),
    /** evidence_updated | submitted | refunded | refused */
    kind: text("kind").notNull(),
    onDate: date("on_date", { mode: "string" }).notNull(),
    reference: text("reference"),
    amount: numeric("amount", { precision: 15, scale: 2 }),
    note: text("note"),
    /** The checklist as it now stands (evidence_updated only). */
    checklist: jsonb("checklist"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({ name: "wht_refund_claim_events_claim_tenant_fk", columns: [t.organizationId, t.claimId], foreignColumns: [whtRefundClaimsTable.organizationId, whtRefundClaimsTable.id] }).onDelete("cascade"),
    index("wht_refund_claim_events_claim_idx").on(t.claimId),
    check("wht_refund_claim_events_kind_chk", sql`${t.kind} in ('evidence_updated', 'submitted', 'refunded', 'refused')`),
    check("wht_refund_claim_events_amount_chk", sql`(${t.kind} = 'refunded') = (${t.amount} is not null) and (${t.amount} is null or ${t.amount} > 0)`),
    check("wht_refund_claim_events_checklist_chk", sql`(${t.kind} = 'evidence_updated') = (${t.checklist} is not null)`),
  ],
);

export const whtInstalmentRequestsTable = pgTable(
  "wht_instalment_requests",
  {
    id: serial("id").primaryKey(),
    ...tenant(),
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    principal: numeric("principal", { precision: 15, scale: 2 }).notNull(),
    requestedOn: date("requested_on", { mode: "string" }).notNull(),
    reference: text("reference").notNull(),
    note: text("note"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("wht_instalment_requests_org_id_unq").on(t.organizationId, t.id),
    check("wht_instalment_requests_period_chk", sql`${t.periodFrom} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and ${t.periodTo} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and ${t.periodFrom} <= ${t.periodTo}`),
    // Resolution 1117 (as recorded): returns due before 1 July 2026 — WHT months up to 2026-05
    check("wht_instalment_requests_1117_chk", sql`${t.periodTo} <= '2026-05'`),
    check("wht_instalment_requests_principal_chk", sql`${t.principal} > 0`),
    check("wht_instalment_requests_reference_chk", sql`length(btrim(${t.reference})) > 0`),
  ],
);

export const whtInstalmentRequestEventsTable = pgTable(
  "wht_instalment_request_events",
  {
    id: serial("id").primaryKey(),
    ...tenant(),
    requestId: integer("request_id").notNull(),
    /** accepted (ZATCA's WRITTEN acceptance) | refused */
    kind: text("kind").notNull(),
    onDate: date("on_date", { mode: "string" }).notNull(),
    reference: text("reference"),
    note: text("note"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({ name: "wht_instalment_request_events_request_tenant_fk", columns: [t.organizationId, t.requestId], foreignColumns: [whtInstalmentRequestsTable.organizationId, whtInstalmentRequestsTable.id] }).onDelete("cascade"),
    index("wht_instalment_request_events_request_idx").on(t.requestId),
    check("wht_instalment_request_events_kind_chk", sql`${t.kind} in ('accepted', 'refused')`),
    check("wht_instalment_request_events_acceptance_chk", sql`${t.kind} <> 'accepted' or length(btrim(coalesce(${t.reference}, ''))) > 0`),
  ],
);
