import { pgTable, serial, uuid, integer, text, timestamp, jsonb, check, index, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

/**
 * 🔴 A15 (owner decisions 2026-11-16/17; migration 0163) — THE BACK-FILL'S OWN RECORD: one row per journal entry whose
 * source tag the 0163 back-fill wrote, with what it was before (always none), what it became, the rule and the
 * evidence that decided it, the migration that wrote it and when.
 *
 *  - The rules (authoritative relationships only, never a guess): F — a document's own key names the entry; N — the
 *    number the document's writer composes, with the document in the same organisation and company, posted, and
 *    the entry's date and total agreeing; S — Batch 1C's `source` column; A — the manual route's own audit row;
 *    R — `reversal_of`, where nothing else claims the entry; U — none of these, or two disagreeing, or a failed
 *    check: the entry reads `legacy_unclassified`, and the evidence says which.
 *  - Written ONLY by the back-fill, as the table owner (no grant to the application's role). The posted-journal
 *    freeze admits the tag write on a posted entry only where this table holds the matching row
 *    (`zz_journal_entries_posted_frozen`, `journal_entries_source_tag_guard`).
 *  - APPEND-ONLY for every role, the owner included, while its company exists (the control_flags pattern).
 *  - No foreign key to the entry: a back-filled DRAFT may later be deleted (a draft is unrestricted), and its record
 *    stays.
 */
export const journalSourceBackfillTable = pgTable(
  "journal_source_backfill",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    journalEntryId: integer("journal_entry_id").notNull(),
    entryNumber: text("entry_number").notNull(),
    entryStatus: text("entry_status").notNull(),
    previousSourceType: text("previous_source_type"),
    previousSourceId: integer("previous_source_id"),
    newSourceType: text("new_source_type").notNull(),
    newSourceId: integer("new_source_id"),
    rule: text("rule").$type<"F" | "N" | "S" | "A" | "R" | "U">().notNull(),
    evidence: jsonb("evidence").notNull(),
    migrationVersion: text("migration_version").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("journal_source_backfill_entry_unq").on(t.journalEntryId),
    check("journal_source_backfill_rule_chk", sql`${t.rule} in ('F', 'N', 'S', 'A', 'R', 'U')`),
    check("journal_source_backfill_previous_chk", sql`${t.previousSourceType} is null and ${t.previousSourceId} is null`),
    check("journal_source_backfill_unclassified_chk", sql`(${t.rule} = 'U') = (${t.newSourceType} = 'legacy_unclassified')`),
    check("journal_source_backfill_not_synthetic_chk", sql`${t.newSourceType} not in ('demo_seed', 'test_fixture')`),
    index("journal_source_backfill_company_idx").on(t.companyId, t.recordedAt),
  ],
);
