/**
 * 🔴 A15 review (migration 0164) — the unclassified-entries review reads and writes ONLY through its two database
 * functions: `journal_source_review_list` (the screen's one reader, scoped by the tenant settings) and
 * `journal_source_review_classify` (the review act). The records are owner-only, so there is no table access here.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type ReviewListRow = {
  entry_id: number;
  entry_number: string | null;
  entry_date: string;
  entry_status: string;
  description: string | null;
  total: string | number;
  current_source_type: string;
  current_source_id: number | null;
  backfill_evidence: Record<string, unknown> | null;
  candidates: Array<{ rule: string; type: string; source_id: number | null; checks_pass: boolean; evidence: Record<string, unknown> }> | null;
  review: { id: number; new_source_type: string; new_source_id: number | null; rule: string; reviewed_at: string } | null;
  total_count: string | number;
};

export const journalSourceReviewRepository = {
  async list(limit: number, offset: number, entryId: number | null = null): Promise<ReviewListRow[]> {
    const { rows } = await db.execute<ReviewListRow>(
      sql`SELECT * FROM journal_source_review_list(${limit}::integer, ${offset}::integer, ${entryId}::integer)`,
    );
    return rows;
  },

  async classify(entryId: number, sourceType: string, sourceId: number | null): Promise<number> {
    const { rows } = await db.execute<{ id: number }>(
      sql`SELECT journal_source_review_classify(${entryId}::integer, ${sourceType}::text, ${sourceId}::integer) AS id`,
    );
    return Number(rows[0]?.id);
  },
};
