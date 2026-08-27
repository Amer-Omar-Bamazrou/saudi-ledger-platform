/** Transactions repository — tenant-scoped via RLS. */
import { db, transactionsTable, categoriesTable } from "@workspace/db";
import { and, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";

export interface TransactionFilter {
  categoryId?: number | null;
  isManuallyOverridden?: boolean | null;
  type?: string | null;
  search?: string | null;
  limit?: number | null;
  offset?: number | null;
}

function whereFor(f: TransactionFilter) {
  const conditions = [];
  if (f.categoryId != null) conditions.push(eq(transactionsTable.categoryId, f.categoryId));
  if (f.isManuallyOverridden != null)
    conditions.push(eq(transactionsTable.isManuallyOverridden, f.isManuallyOverridden));
  if (f.type != null) conditions.push(eq(transactionsTable.type, f.type));
  if (f.search) conditions.push(ilike(transactionsTable.description, `%${f.search}%`));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const transactionsRepository = {
  list(f: TransactionFilter) {
    return db
      .select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(whereFor(f))
      .orderBy(desc(transactionsTable.date), desc(transactionsTable.id))
      .limit(f.limit ?? 50)
      .offset(f.offset ?? 0);
  },

  count(f: TransactionFilter) {
    return db.select({ count: sql<number>`count(*)::int` }).from(transactionsTable).where(whereFor(f));
  },

  findWithCategory(id: number) {
    return db
      .select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(eq(transactionsTable.id, id))
      .limit(1);
  },

  insert(values: typeof transactionsTable.$inferInsert) {
    return db.insert(transactionsTable).values(values).returning();
  },

  /**
   * Does an IDENTICAL row already exist? (M15 duplicate guard.)
   *
   * The key is (date, description, amount, type) — deliberately INCLUDING the
   * full description. Statement lines carry references ("TRANSFER TO ALMARAI -
   * INV 88231" vs "… INV 88240"), so two genuine same-amount-same-payee
   * payments differ in description and BOTH survive. What this catches is the
   * same statement uploaded twice, where every field is byte-identical — which
   * previously doubled every tax figure silently.
   *
   * Two genuinely identical rows (same day, same wording, same amount, no
   * reference) WILL be collapsed, and that is the accepted trade: the response
   * reports every skip, so the rarer case is visible and re-enterable by hand,
   * while the common failure (a re-upload) stops corrupting VAT and Zakat.
   */
  /**
   * Accept rows into the books.
   *
   * 🔴 THE BLIND-ACCEPT GUARD lives HERE, server-side, not in the UI. A single
   * "Accept all" that sweeps in rows nobody read manufactures a human's
   * recorded acceptance of things no human looked at — worse than no gate,
   * because it creates false assurance.
   *
   * So bulk mode (`ids` omitted) accepts ONLY rows that are safe to accept in
   * bulk: categorized, with confidence at or above the auto-assign threshold
   * (or manually categorized/overridden). Uncategorized and low-confidence rows
   * are NEVER swept in — accepting those requires naming them (`ids`), which is
   * what makes the acceptance deliberate. The UI separates them visually; this
   * makes the separation binding rather than cosmetic.
   */
  async acceptPending(opts: { ids?: number[]; minConfidence: number }): Promise<{ accepted: number; acceptedIds: number[] }> {
    if (opts.ids && opts.ids.length > 0) {
      const r = await db
        .update(transactionsTable)
        .set({ reviewStatus: "accepted" })
        .where(and(eq(transactionsTable.reviewStatus, "pending_review"), inArray(transactionsTable.id, opts.ids)))
        .returning({ id: transactionsTable.id });
      return { accepted: r.length, acceptedIds: r.map((x) => x.id) };
    }
    const r = await db
      .update(transactionsTable)
      .set({ reviewStatus: "accepted" })
      .where(
        and(
          eq(transactionsTable.reviewStatus, "pending_review"),
          // M16.2: a TRANSFER carries no category by design — the kind IS the
          // classification — so a confident transfer is bulk-safe alongside
          // categorized rows. Everything else still needs a category.
          or(isNotNull(transactionsTable.categoryId), eq(transactionsTable.kind, "transfer")),
          or(
            eq(transactionsTable.isManuallyOverridden, true),
            sql`${transactionsTable.confidenceScore}::numeric >= ${String(opts.minConfidence)}`,
          ),
        ),
      )
      .returning({ id: transactionsTable.id });
    return { accepted: r.length, acceptedIds: r.map((x) => x.id) };
  },

  /**
   * 🔴 COUNTS OVER THE FULL SET, computed in SQL — never `array.length`.
   *
   * `pendingReview` below is CAPPED (200) because it feeds a review screen that
   * renders rows. Counting its result was the defect: `unreviewedCount` in the
   * Finance Hub saturated at 200, so a tenant with 5,000 unreviewed rows was
   * told 200 — a wrong number presented as the answer to "are my books
   * current?". `needsAttentionCount` was worse: it filtered WITHIN the capped
   * page, so it was not even a proportional sample, just "of the 200 most
   * recent".
   *
   * 🔴 The property that made it survive: it is invisible on any dataset small
   * enough to develop against. The dev org has 45 transactions. It appears the
   * month a real tenant gets busy — see CLAUDE.md §3.
   *
   * `needsAttention` mirrors the predicate in `transactions.service`
   * (uncategorised non-transfer, OR low confidence and not manually
   * overridden). Two expressions of one rule is the drift hazard the repo
   * names elsewhere; they are kept adjacent deliberately, and the service test
   * pins that they agree.
   */
  async pendingReviewCounts(autoAssignConfidence: number): Promise<{ total: number; needsAttention: number }> {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        needsAttention: sql<number>`count(*) FILTER (WHERE
          (${transactionsTable.categoryId} IS NULL AND ${transactionsTable.kind} <> 'transfer')
          OR (${transactionsTable.confidenceScore} IS NOT NULL
              AND ${transactionsTable.confidenceScore} < ${autoAssignConfidence}
              AND ${transactionsTable.isManuallyOverridden} = false)
        )::int`,
      })
      .from(transactionsTable)
      .where(eq(transactionsTable.reviewStatus, "pending_review"));
    return { total: Number(row?.total ?? 0), needsAttention: Number(row?.needsAttention ?? 0) };
  },

  /** Pending rows, most recent first — the review surface's data. */
  pendingReview(limit = 200) {
    return db
      .select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(eq(transactionsTable.reviewStatus, "pending_review"))
      .orderBy(desc(transactionsTable.date), desc(transactionsTable.id))
      .limit(limit);
  },

  async existsIdentical(v: {
    date: string;
    description: string;
    amount: string;
    type: string;
    /**
     * M16.2 — duplicates are scoped to the ACCOUNT (null-safe): the same salary
     * paid from two accounts is two real transactions; the duplicate case is a
     * statement re-uploaded against its own account. `IS NOT DISTINCT FROM`
     * keeps pre-M16.2 (accountless) uploads deduplicating against each other.
     */
    bankAccountId: number | null;
  }): Promise<boolean> {
    const [row] = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.date, v.date),
          eq(transactionsTable.description, v.description),
          eq(transactionsTable.amount, v.amount),
          eq(transactionsTable.type, v.type),
          sql`${transactionsTable.bankAccountId} IS NOT DISTINCT FROM ${v.bankAccountId}`,
        ),
      )
      .limit(1);
    return !!row;
  },

  update(id: number, values: Partial<typeof transactionsTable.$inferInsert>) {
    return db.update(transactionsTable).set(values).where(eq(transactionsTable.id, id));
  },

  remove(id: number) {
    return db.delete(transactionsTable).where(eq(transactionsTable.id, id));
  },
};
