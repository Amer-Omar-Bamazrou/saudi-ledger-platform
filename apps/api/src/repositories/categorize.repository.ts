/** Categorization repository — transactions/categories data access (tenant-scoped via RLS). */
import { db, transactionsTable, categoriesTable } from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";

/**
 * 🔴 THE ACCEPTANCE-GUARANTEE GATE (audit Tier 2, finding 3).
 *
 * Every categorize run — bulk, override, or explicit ids — is confined to
 * rows that are (a) still PENDING review and (b) `kind = 'operating'`.
 *
 * Pre-fix this repository had NO reviewStatus/kind filter, so a run could
 * silently rewrite already-ACCEPTED rows: add extracted VAT, change the
 * category, or flip an accepted row to `kind='transfer'` — retroactively
 * moving VAT/Zakat/income figures the human's recorded acceptance was FOR.
 * The M15 holding-area guarantee is that acceptance covers the numbers as
 * accepted; a categorize run must therefore stop at the acceptance boundary.
 * Changing an accepted row is a deliberate per-row human act (PATCH), which
 * stamps `is_manually_overridden` and is individually audited.
 *
 * The `kind` filter keeps transfer/settlement rows out even by explicit id:
 * a transfer's classification IS its kind (it carries no category by design),
 * and a settlement's category/VAT strip is part of the settlement contract.
 */
const categorizable = () =>
  and(eq(transactionsTable.reviewStatus, "pending_review"), eq(transactionsTable.kind, "operating"));

export const categorizeRepository = {
  fetchTransactions(transactionIds?: number[], overrideExisting?: boolean | null) {
    let query = db.select({ tx: transactionsTable }).from(transactionsTable).$dynamic();
    if (transactionIds && transactionIds.length > 0) {
      query = query.where(and(inArray(transactionsTable.id, transactionIds), categorizable())) as typeof query;
    } else if (!overrideExisting) {
      query = query.where(and(isNull(transactionsTable.categoryId), categorizable())) as typeof query;
    } else {
      // overrideExisting with no ids: every categorizable row.
      query = query.where(categorizable()) as typeof query;
    }
    return query;
  },

  allCategories() {
    return db.select().from(categoriesTable);
  },

  updateCategory(id: number, values: Partial<typeof transactionsTable.$inferInsert>) {
    // Belt to the fetch filter's braces: the write itself refuses to touch a
    // row past the acceptance boundary, so a future call site cannot bypass
    // the gate by constructing ids some other way.
    return db
      .update(transactionsTable)
      .set(values)
      .where(and(eq(transactionsTable.id, id), categorizable()));
  },
};
