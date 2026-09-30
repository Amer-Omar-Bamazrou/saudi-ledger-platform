/**
 * PHASE 13B-1 — THE INPUT-VAT EVENT LEDGER: FOUNDATION ONLY (2026-09-28).
 * Record: docs/product/phase-13b-vat-claim-ledger-architecture.md §5–§6, §25.
 *
 * Where a purchase document's input VAT IS, as an append-only history of
 * TRANSFERS between buckets:
 *
 *   HELD · CLAIMED · REVERSED_UNPAID · BLOCKED · CORRECTED_BLOCKED · LAPSED
 *   (NONE = out of / into existence; both NONE = an annotation)
 *
 * 13B-1 built the foundation. 🔴 13B-3 (migration 0109) is the first
 * PRODUCTION WRITER — `services/accounting/inputVatLedger.service.ts`, called
 * from the bill approval, the supplier advance documents and the evidence
 * claim — and it reconstructs every pre-existing document's events (the 13B-4
 * backfill, pulled forward; provenance `reconstructed`). From 0109 the
 * `bills.input_vat_*` columns are a CACHE of these events, checked at commit
 * by `bills_input_vat_cache_consistency`.
 *
 * What the DATABASE refuses (migration 0107, hand-written — drizzle tracks
 * neither triggers nor grants): a transition that is not ADMITTED in
 * `input_vat_event_transitions`; a bucket going negative; a partial claim;
 * a second recognition/claim/reversal-for-the-month/restoration-per-payment;
 * an event on another tenant's document, entry, capture or event; an event
 * dated before its document; a lapse posted on any date but its real one;
 * any UPDATE, DELETE or TRUNCATE of an event (owner included); an event whose
 * journal entry is not the one its role names, or whose amount is not that
 * entry's VAT line; a journal entry marked `input_vat_event` that no event
 * references; the generic reversal of an entry the ledger (or a bill) owns.
 *
 * EVENT TYPE ≠ BUCKET ≠ TRANSITION ≠ FEATURE: a transition is ADMITTED when
 * the database accepts it; it is ENABLED only when a production writer
 * produces it. 13B-3 enables recognition, `claimed`, `advance_deducted` and
 * `reduced_by_note` (the settled credit-note cases only, O-1/O-2; A-B1-1);
 * `increased_by_note` is RETIRED (debit notes are their own documents, O-3)
 * and `correction_withdrawn` stays NOT admitted (AD-11).
 */
import { pgTable, serial, integer, text, numeric, uuid, timestamp, jsonb, boolean, index, uniqueIndex, check, foreignKey, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { billsTable } from "./bills";
import { journalEntriesTable } from "./journalEntries";
import { capturedDocumentsTable } from "./capturedDocuments";
import { openingPayableVatDeclarationsTable } from "./openingPayableVatDeclarations";

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
 * The buckets, plus NONE (out of / into existence). One definition, used by the CHECKs.
 *
 * NOT_DEDUCTED (Phase 13B S1, 2026-09-30): historical input VAT an OPENING
 * payable's previous system never deducted and carried in cost (accountant
 * AQ-2). Entered only by a declared recognition; left only by a credit note.
 * Semantically distinct from BLOCKED (Art. 50) and REVERSED_UNPAID (Art. 40(10)).
 */
export const INPUT_VAT_BUCKETS = ["NONE", "HELD", "CLAIMED", "REVERSED_UNPAID", "BLOCKED", "CORRECTED_BLOCKED", "LAPSED", "NOT_DEDUCTED"] as const;
export type InputVatBucket = (typeof INPUT_VAT_BUCKETS)[number];
const BUCKETS_SQL = sql.raw(INPUT_VAT_BUCKETS.map((b) => `'${b}'`).join(", "));

/**
 * How an event's journal entry relates to its document (§8.1).
 * `note_entry` (Phase 13B-3, A-B1-3): a `reduced_by_note` event on the ORIGINAL
 * references the NOTE's own posted entry (`BILLCN-` / `BILLADVCN-`).
 */
export const INPUT_VAT_JOURNAL_ROLES = ["own_entry", "claim_entry", "event_entry", "note_entry"] as const;
const ROLES_SQL = sql.raw(INPUT_VAT_JOURNAL_ROLES.map((r) => `'${r}'`).join(", "));

/**
 * Reference data, seeded by the migration and read-only to the app role: the
 * (type, from, to) triples that exist at all, and which the database ADMITS.
 */
export const inputVatEventTransitionsTable = pgTable(
  "input_vat_event_transitions",
  {
    eventType: text("event_type").notNull(),
    fromBucket: text("from_bucket").notNull(),
    toBucket: text("to_bucket").notNull(),
    /** NULL = the event has no journal entry (an annotation). */
    journalRole: text("journal_role"),
    admitted: boolean("admitted").notNull(),
    /** The batch whose writer first produces it — documentation only. */
    enabledIn: text("enabled_in").notNull(),
    basis: text("basis").notNull(),
  },
  (t) => [
    // A PRIMARY KEY (not a unique index): created with the table, so the events
    // table's composite FK can reference it in the same migration.
    primaryKey({ name: "input_vat_event_transitions_pk", columns: [t.eventType, t.fromBucket, t.toBucket] }),
    check("input_vat_event_transitions_bucket_chk", sql`from_bucket IN (${BUCKETS_SQL}) AND to_bucket IN (${BUCKETS_SQL})`),
    check("input_vat_event_transitions_role_chk", sql`journal_role IS NULL OR journal_role IN (${ROLES_SQL})`),
  ],
);

export const inputVatEventsTable = pgTable(
  "input_vat_events",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    documentId: integer("document_id").notNull().references(() => billsTable.id, { onDelete: "restrict" }),
    /** A note's original, or the advance a final bill deducts. */
    relatedDocumentId: integer("related_document_id").references(() => billsTable.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    fromBucket: text("from_bucket").notNull(),
    toBucket: text("to_bucket").notNull(),
    /** Positive; direction is the (from, to) pair. NULL only on an annotation. */
    amount: numeric("amount", { precision: 15, scale: 2 }),
    /** The STATUTORY/real date of the fact (evidence date, end of M+12, payment, discovery, EXPIRY). */
    occurredOn: text("occurred_on").notNull(),
    /** The accounting date — equals the linked entry's date. Distinct from occurred_on by design. */
    postingDate: text("posting_date").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
    /** Art. 40(10) only: the month (YYYY-MM) whose end triggered the reversal. */
    triggerMonth: text("trigger_month"),
    reason: text("reason"),
    causeType: text("cause_type"),
    causeId: integer("cause_id"),
    followsEventId: integer("follows_event_id"),
    evidenceCaptureId: uuid("evidence_capture_id").references(() => capturedDocumentsTable.id, { onDelete: "restrict" }),
    evidenceSnapshot: jsonb("evidence_snapshot"),
    journalEntryId: integer("journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    journalRole: text("journal_role"),
    correctionRoute: text("correction_route"),
    affectedPeriodStart: text("affected_period_start"),
    affectedPeriodEnd: text("affected_period_end"),
    ruleVersion: text("rule_version"),
    /** Exactly one of the two — a person, or a named system identity (e.g. `migration:0107`). */
    actorUserId: integer("actor_user_id"),
    actorSystem: text("actor_system"),
    /**
     * `recorded` = written when it happened; `reconstructed` = rebuilt later by a
     * named migration (R3); `declared` (S1) = an opening payable's historical VAT
     * position, stated in an attributed, evidenced declaration (`declaration_id`).
     */
    provenance: text("provenance").notNull(),
    /** S1: the historical VAT declaration a `declared` event states — required for it, forbidden otherwise. */
    declarationId: integer("declaration_id").references(() => openingPayableVatDeclarationsTable.id, { onDelete: "restrict" }),
    backfillMigration: text("backfill_migration"),
    backfillSource: text("backfill_source"),
    sourceRecordRef: text("source_record_ref"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** The document's bucket balances after this event — WRITTEN BY THE TRIGGER, never by the caller. */
    bucketsAfter: jsonb("buckets_after").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    foreignKey({
      name: "input_vat_events_transition_fk",
      columns: [t.eventType, t.fromBucket, t.toBucket],
      foreignColumns: [inputVatEventTransitionsTable.eventType, inputVatEventTransitionsTable.fromBucket, inputVatEventTransitionsTable.toBucket],
    }).onDelete("restrict"),
    foreignKey({ name: "input_vat_events_follows_fk", columns: [t.followsEventId], foreignColumns: [t.id] }).onDelete("restrict"),
    uniqueIndex("input_vat_events_idempotency_unq").on(t.organizationId, t.idempotencyKey),
    index("input_vat_events_document_idx").on(t.companyId, t.documentId, t.id),
    index("input_vat_events_posting_idx").on(t.companyId, t.postingDate),
    index("input_vat_events_follows_idx").on(t.followsEventId),
    index("input_vat_events_entry_idx").on(t.journalEntryId),
    // An entry the ledger posted itself, or an evidence-claim entry, belongs to ONE event.
    uniqueIndex("input_vat_events_own_journal_unq").on(t.journalEntryId).where(sql`journal_role IN ('claim_entry', 'event_entry')`),
    // Phase 13B-3 (NI-5): a note's entry, and a note, belong to ONE reduction event.
    uniqueIndex("input_vat_events_note_journal_unq").on(t.journalEntryId).where(sql`journal_role = 'note_entry'`),
    uniqueIndex("input_vat_events_one_per_note_unq").on(t.relatedDocumentId).where(sql`event_type = 'reduced_by_note'`),
    // 🔴 Double acts made UNWRITABLE, not merely checked.
    uniqueIndex("input_vat_events_one_recognition_unq").on(t.documentId, t.eventType).where(sql`event_type LIKE 'recognised\\_%'`),
    // Phase 13B-3: ONE recognition per document, whatever its type (the index above allows one of EACH type).
    uniqueIndex("input_vat_events_one_recognition_per_document_unq").on(t.documentId).where(sql`event_type LIKE 'recognised\\_%'`),
    // Phase 13B-3: a final bill deducts each supplier advance ONCE (Z-AP1 — one prepayment row per advance).
    uniqueIndex("input_vat_events_one_advance_deduction_unq").on(t.documentId, t.relatedDocumentId).where(sql`event_type = 'advance_deducted'`),
    uniqueIndex("input_vat_events_one_claim_unq").on(t.documentId).where(sql`event_type = 'claimed'`),
    // S1: an opening payable's historical position is declared ONCE.
    uniqueIndex("input_vat_events_one_declared_opening_unq").on(t.documentId).where(sql`event_type = 'declared_opening'`),
    uniqueIndex("input_vat_events_one_reversal_unq").on(t.documentId, t.triggerMonth).where(sql`event_type = 'reversed_unpaid'`),
    uniqueIndex("input_vat_events_one_restoration_unq").on(t.documentId, t.causeId).where(sql`event_type = 'restored_on_payment'`),
    // (No one-lapse-per-document index: whether a PARTIAL write-off exists is not decided, so HELD bounds a lapse and nothing more.)
    check("input_vat_events_bucket_chk", sql`from_bucket IN (${BUCKETS_SQL}) AND to_bucket IN (${BUCKETS_SQL})`),
    check("input_vat_events_amount_chk", sql`(amount IS NULL OR amount > 0) AND (amount IS NOT NULL OR (from_bucket = 'NONE' AND to_bucket = 'NONE'))`),
    check("input_vat_events_dates_chk", sql`occurred_on ~ '^\\d{4}-\\d{2}-\\d{2}$' AND posting_date ~ '^\\d{4}-\\d{2}-\\d{2}$' AND posting_date >= occurred_on`),
    check("input_vat_events_trigger_month_chk", sql`(trigger_month IS NULL OR trigger_month ~ '^\\d{4}-\\d{2}$') AND ((event_type = 'reversed_unpaid') = (trigger_month IS NOT NULL))`),
    check("input_vat_events_actor_chk", sql`(actor_user_id IS NULL) <> (actor_system IS NULL) AND (actor_user_id IS NULL OR length(btrim(coalesce(reason, ''))) > 0)`),
    check(
      "input_vat_events_provenance_chk",
      sql`(provenance = 'recorded' AND backfill_migration IS NULL AND backfill_source IS NULL AND source_record_ref IS NULL AND declaration_id IS NULL)
       OR (provenance = 'reconstructed' AND backfill_migration IS NOT NULL AND backfill_source IS NOT NULL AND source_record_ref IS NOT NULL
           AND actor_user_id IS NULL AND actor_system LIKE 'migration:%' AND declaration_id IS NULL)
       OR (provenance = 'declared' AND declaration_id IS NOT NULL AND backfill_migration IS NULL AND backfill_source IS NULL
           AND source_record_ref IS NULL AND event_type = 'declared_opening')`,
    ),
    check("input_vat_events_journal_chk", sql`(journal_role IS NULL) = (journal_entry_id IS NULL) AND (journal_role IS NULL OR journal_role IN (${ROLES_SQL}))`),
    check("input_vat_events_idempotency_chk", sql`length(btrim(idempotency_key)) > 0`),
  ],
);

/**
 * One row per document: its bucket balances. Maintained ONLY by the event
 * trigger (the app role may read it, never write it); the invariant sweep
 * proves it equals the sum of the events.
 */
export const inputVatBalancesTable = pgTable(
  "input_vat_balances",
  {
    documentId: integer("document_id").primaryKey().references(() => billsTable.id, { onDelete: "restrict" }),
    ...tenantColumns,
    held: numeric("held", { precision: 15, scale: 2 }).notNull().default("0"),
    claimed: numeric("claimed", { precision: 15, scale: 2 }).notNull().default("0"),
    reversedUnpaid: numeric("reversed_unpaid", { precision: 15, scale: 2 }).notNull().default("0"),
    blocked: numeric("blocked", { precision: 15, scale: 2 }).notNull().default("0"),
    correctedBlocked: numeric("corrected_blocked", { precision: 15, scale: 2 }).notNull().default("0"),
    lapsed: numeric("lapsed", { precision: 15, scale: 2 }).notNull().default("0"),
    /** S1: historical VAT never deducted (AQ-2) — see INPUT_VAT_BUCKETS. */
    notDeducted: numeric("not_deducted", { precision: 15, scale: 2 }).notNull().default("0"),
    lastEventId: integer("last_event_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("input_vat_balances_company_idx").on(t.companyId),
    check("input_vat_balances_nonnegative_chk", sql`held >= 0 AND claimed >= 0 AND reversed_unpaid >= 0 AND blocked >= 0 AND corrected_blocked >= 0 AND lapsed >= 0 AND not_deducted >= 0`),
  ],
);

export type InputVatEvent = typeof inputVatEventsTable.$inferSelect;
export type InputVatBalances = typeof inputVatBalancesTable.$inferSelect;
