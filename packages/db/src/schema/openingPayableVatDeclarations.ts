/**
 * PHASE 13B S1 — AN OPENING PAYABLE'S HISTORICAL INPUT-VAT POSITION (2026-09-30).
 * Records: docs/product/phase-13b-level-policy-implementation-contract.md §15–§16
 *          (AC-8; owner decisions D1–D7); decision paper
 *          docs/product/phase-13b3-opening-payable-credit-note-decision-paper.md
 *          §0.1 (AQ-1 evidence), §0.2 (AQ-2), §B, §F (option D), §M.4.
 *
 * A migrated (Batch 1C) payable carries no VAT of its own (`bills_opening_no_vat_chk`):
 * its input VAT was accounted for in the PREVIOUS system. How it was treated there —
 * deducted, never deducted, blocked under Art. 50, reversed under Art. 40(10) — decides
 * what a later supplier credit note does to input VAT (IR 40(6); accountant AQ-1/AQ-2, R1).
 *
 * This is the ONE place that position is stated: an attributed, evidenced, append-only
 * DECLARATION per committed staging item. It never touches the frozen staging row
 * (`migration_open_items`), and it reads no key of `historical_vat` as a deduction
 * state (`reportedPeriod` and the bad-debt keys are not repurposed — paper §E.5).
 * It feeds the input-VAT ledger through ONE `declared_opening` event, in the same
 * transaction; from then on the ledger's buckets are the source of truth.
 *
 * 🔴 What the database refuses (migration 0110, hand-written): a second declaration
 * for an item; a declaration whose state lacks its facts or its evidence
 * (AQ-1 / §M.4 — checked at COMMIT, so evidence rows land in the same transaction);
 * a state S1 does not act on; a reversal whose location is not `cost` (D7);
 * a deducted history an unpaid 40(10) trigger before the cut-over contradicts
 * (§15.1.4); an item, bill or capture of another tenant; any UPDATE, DELETE or
 * TRUNCATE (owner included).
 */
import { pgTable, serial, integer, text, numeric, uuid, timestamp, boolean, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { billsTable } from "./bills";
import { capturedDocumentsTable } from "./capturedDocuments";
import { migrationOpenItemsTable } from "./migrationBatches";

const tenantColumns = {
  organizationId: uuid("organization_id")
    .notNull()
    .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
    .references(() => organizationsTable.id),
  companyId: uuid("company_id")
    .notNull()
    .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
    .references(() => companiesTable.id),
};

/**
 * The historical states S1 acts on (D3). PARTIALLY_DEDUCTED, a partly-restored
 * reversal, Art. 51 and line splits are S2/S3 — not representable here yet, so
 * they cannot be declared by accident.
 */
export const OPENING_VAT_STATES = ["DEDUCTED", "NOT_DEDUCTED", "BLOCKED_ART50", "REVERSED_ART40_10"] as const;
export type OpeningVatState = (typeof OPENING_VAT_STATES)[number];

/** The evidence kinds (accountant AQ-1 and the §M.4 product evidence policy — NOT a ZATCA schema). */
export const OPENING_VAT_EVIDENCE_KINDS = [
  "ORIGINAL_TAX_INVOICE", // E1
  "DEDUCTION_RETURN", // E2 — the historical return (or VAT ledger record) showing the deduction
  "REVERSAL_RETURN", // E3 — the return showing the Art. 40(10) reversal
  "PAYMENT_RECORDS", // E5 — paid / unpaid consideration
  "CLASSIFICATION", // E-CLS — the Art. 50 classification evidence (always required: paper §B product default)
] as const;
export type OpeningVatEvidenceKind = (typeof OPENING_VAT_EVIDENCE_KINDS)[number];

const STATES_SQL = sql.raw(OPENING_VAT_STATES.map((s) => `'${s}'`).join(", "));
const KINDS_SQL = sql.raw(OPENING_VAT_EVIDENCE_KINDS.map((s) => `'${s}'`).join(", "));

export const openingPayableVatDeclarationsTable = pgTable(
  "opening_payable_vat_declarations",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    /** The committed staging item — ONE declaration per item, ever. */
    migrationOpenItemId: integer("migration_open_item_id").notNull().references(() => migrationOpenItemsTable.id, { onDelete: "restrict" }),
    /** The LIVE opening bill at declaration (its events carry the position). */
    billId: integer("bill_id").notNull().references(() => billsTable.id, { onDelete: "restrict" }),
    state: text("state").notNull(),
    /** H(D): the historical invoice's VAT — the credit-note ceiling T(D) for this payable (D5(a)). */
    historicalVat: numeric("historical_vat", { precision: 15, scale: 2 }).notNull(),
    /** The historical rate, % — equals the staged rate when one was staged. */
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull(),
    /** YYYY-MM: the return period that deducted it (DEDUCTED; and before a reversal). */
    deductedPeriod: text("deducted_period"),
    /** NOT_DEDUCTED: why it was never deducted. */
    notDeductedReason: text("not_deducted_reason"),
    /** NOT_DEDUCTED: the AQ-2 premise — the previous system carried it in cost or the asset. */
    carriedInCost: boolean("carried_in_cost"),
    /** BLOCKED_ART50: the Art. 50 ground. */
    art50Ground: text("art50_ground"),
    /** REVERSED_ART40_10: YYYY-MM, the return period of the reversal. */
    reversedPeriod: text("reversed_period"),
    /** REVERSED_ART40_10 (D7): where the previous system carried the reversed VAT. S1 admits `cost` only. */
    reversedVatLocation: text("reversed_vat_location"),
    /** Optional pointer into the previous system (entry number, return reference). */
    recordReference: text("record_reference"),
    /** The declarant's statement, as shown when they declared. */
    statement: text("statement").notNull(),
    declaredBy: integer("declared_by").notNull(),
    /** YYYY-MM-DD: the business date of the declaration — its ledger event's date. */
    declaredOn: text("declared_on").notNull(),
    declaredAt: timestamp("declared_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("opening_payable_vat_declarations_item_unq").on(t.migrationOpenItemId),
    index("opening_payable_vat_declarations_bill_idx").on(t.billId),
    index("opening_payable_vat_declarations_company_idx").on(t.companyId),
    check("opening_payable_vat_declarations_state_chk", sql`state IN (${STATES_SQL})`),
    check("opening_payable_vat_declarations_amounts_chk", sql`historical_vat > 0 AND vat_rate > 0 AND vat_rate <= 100`),
    check(
      "opening_payable_vat_declarations_periods_chk",
      sql`(deducted_period IS NULL OR deducted_period ~ '^\\d{4}-(0[1-9]|1[0-2])$')
      AND (reversed_period IS NULL OR reversed_period ~ '^\\d{4}-(0[1-9]|1[0-2])$')
      AND declared_on ~ '^\\d{4}-\\d{2}-\\d{2}$'
      AND length(btrim(statement)) > 0`,
    ),
    // Each state carries exactly its own facts (AQ-1, AQ-2, D7) — nothing of another state's.
    check(
      "opening_payable_vat_declarations_facts_chk",
      sql`(state = 'DEDUCTED' AND deducted_period IS NOT NULL
            AND not_deducted_reason IS NULL AND carried_in_cost IS NULL AND art50_ground IS NULL
            AND reversed_period IS NULL AND reversed_vat_location IS NULL)
       OR (state = 'NOT_DEDUCTED' AND length(btrim(coalesce(not_deducted_reason, ''))) > 0 AND carried_in_cost IS TRUE
            AND deducted_period IS NULL AND art50_ground IS NULL AND reversed_period IS NULL AND reversed_vat_location IS NULL)
       OR (state = 'BLOCKED_ART50' AND length(btrim(coalesce(art50_ground, ''))) > 0
            AND deducted_period IS NULL AND not_deducted_reason IS NULL AND carried_in_cost IS NULL
            AND reversed_period IS NULL AND reversed_vat_location IS NULL)
       OR (state = 'REVERSED_ART40_10' AND deducted_period IS NOT NULL AND reversed_period IS NOT NULL
            AND reversed_period >= deducted_period AND reversed_vat_location = 'cost'
            AND not_deducted_reason IS NULL AND carried_in_cost IS NULL AND art50_ground IS NULL)`,
    ),
  ],
);

export const openingPayableVatDeclarationEvidenceTable = pgTable(
  "opening_payable_vat_declaration_evidence",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    declarationId: integer("declaration_id").notNull().references(() => openingPayableVatDeclarationsTable.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    /** A captured document, promoted as evidence of the opening bill (retained, never purged while referenced). */
    captureId: uuid("capture_id").notNull().references(() => capturedDocumentsTable.id, { onDelete: "restrict" }),
    /** The capture's content hash when it was declared — the identity the evidence was checked against. */
    captureSha256: text("capture_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("opening_payable_vat_evidence_unq").on(t.declarationId, t.kind, t.captureId),
    index("opening_payable_vat_evidence_capture_idx").on(t.captureId),
    check("opening_payable_vat_evidence_kind_chk", sql`kind IN (${KINDS_SQL})`),
  ],
);

export type OpeningPayableVatDeclaration = typeof openingPayableVatDeclarationsTable.$inferSelect;
export type OpeningPayableVatDeclarationEvidence = typeof openingPayableVatDeclarationEvidenceTable.$inferSelect;
