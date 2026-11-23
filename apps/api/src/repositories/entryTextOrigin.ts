/**
 * 🔴 19B (review follow-up, 2026-11-24) — an entry's TEXT ORIGIN, the one SQL definition (lib/fieldClasses/conditions.ts
 * explains the three origins). Every read that serves an entry's or a line's text — the journal entries, the reports, the
 * report datasets, the general ledger's export — takes the origin from here, so `bank_narrative`'s row condition reads the
 * same fact everywhere.
 *
 * A mirror (any entry with `reversal_of`) takes its original's origin; a mirror of a mirror, or one whose original is
 * not visible, is `unknown` (the safe error).
 */
import { db, journalEntriesTable } from "@workspace/db";
import { inArray, sql, type SQL } from "drizzle-orm";
import { BANK_LINE_SOURCE_TYPES, UNKNOWN_ORIGIN_SOURCE_TYPES, type TextOrigin } from "../lib/fieldClasses/conditions";

const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** An entry's own origin from its source type (not a mirror). `col` is the source_type column expression. */
const ownOrigin = (col: SQL) => sql`CASE
    WHEN ${col} IN (${list(BANK_LINE_SOURCE_TYPES)}) THEN 'bank_line'
    WHEN ${col} IS NULL OR ${col} IN (${list(UNKNOWN_ORIGIN_SOURCE_TYPES)}) THEN 'unknown'
    ELSE 'document' END`;

/**
 * The origin of the `journal_entries` row in scope (table-qualified: inside the subquery a bare column would bind to
 * the subquery's own table).
 */
export const textOriginSql = (): SQL<TextOrigin> => sql<TextOrigin>`(CASE
    WHEN ${journalEntriesTable}."reversal_of" IS NOT NULL THEN COALESCE(
      (SELECT CASE WHEN o.reversal_of IS NOT NULL THEN 'unknown' ELSE ${ownOrigin(sql`o.source_type`)} END
         FROM journal_entries o WHERE o.id = ${journalEntriesTable}."reversal_of"),
      'unknown')
    ELSE ${ownOrigin(sql`${journalEntriesTable}."source_type"`)} END)`;

export const entryTextOriginRepository = {
  /** Each entry's text origin, by entry id. */
  async textOrigins(entryIds: number[]): Promise<Map<number, TextOrigin>> {
    if (entryIds.length === 0) return new Map();
    const rows = await db
      .select({ id: journalEntriesTable.id, textOrigin: textOriginSql() })
      .from(journalEntriesTable)
      .where(inArray(journalEntriesTable.id, [...new Set(entryIds)]));
    return new Map(rows.map((r) => [r.id, r.textOrigin]));
  },
};
