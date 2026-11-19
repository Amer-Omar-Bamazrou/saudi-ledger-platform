import { pgTable, serial, uuid, integer, text, timestamp, jsonb, check, index, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

/**
 * 🔴 A15 review (owner decisions 2026-11-17 and 2026-11-19; migration 0164) — THE REVIEW ROUTE'S OWN RECORD: one row per
 * `legacy_unclassified` journal entry an administrator classified on the review screen, with the candidate the rules
 * confirmed AT THAT MOMENT, every candidate they found, who chose it and when.
 *
 *  - The review classifies an entry ONLY as a candidate `journal_source_classify` (0163's rules) confirms when the act
 *    runs, never on a stated reason, and never as `manual`: that waits for an accountant-approved policy (owner,
 *    2026-11-17). The candidate's rule is F, N, S or R — never A (the manual route's audit row) and never U.
 *  - Written ONLY by `journal_source_review_classify()` (SECURITY DEFINER, the table owner); the application's role
 *    holds no privilege on the table and reads it through `journal_source_review_list()`. The tag guard and the
 *    posted-journal freeze admit the tag write only where this table holds the matching row and the review is declared.
 *  - APPEND-ONLY for every role, the owner included, while its company exists. One review per entry.
 *  - No foreign key to the entry (as `journal_source_backfill`): a classified DRAFT may later be deleted, and its
 *    record stays.
 */
export const journalSourceReviewsTable = pgTable(
  "journal_source_reviews",
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
    previousSourceType: text("previous_source_type").notNull(),
    newSourceType: text("new_source_type").notNull(),
    newSourceId: integer("new_source_id"),
    rule: text("rule").$type<"F" | "N" | "S" | "R">().notNull(),
    evidence: jsonb("evidence").notNull(),
    reviewedBy: integer("reviewed_by").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("journal_source_reviews_entry_unq").on(t.journalEntryId),
    check("journal_source_reviews_rule_chk", sql`${t.rule} in ('F', 'N', 'S', 'R')`),
    check("journal_source_reviews_previous_chk", sql`${t.previousSourceType} = 'legacy_unclassified'`),
    check("journal_source_reviews_new_chk", sql`${t.newSourceType} not in ('legacy_unclassified', 'demo_seed', 'test_fixture', 'manual')`),
    index("journal_source_reviews_company_idx").on(t.companyId, t.reviewedAt),
  ],
);
