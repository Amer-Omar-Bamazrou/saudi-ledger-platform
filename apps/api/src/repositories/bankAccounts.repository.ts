/** Bank accounts repository — tenant-scoped via RLS. */
import { db, bankAccountsTable, categoriesTable, journalEntryLinesTable, journalEntriesTable } from "@workspace/db";
import { eq, and, ne, sql, inArray } from "drizzle-orm";

export const bankAccountsRepository = {
  list() {
    return db.select().from(bankAccountsTable).orderBy(bankAccountsTable.name);
  },
  findById(id: number) {
    return db.select().from(bankAccountsTable).where(eq(bankAccountsTable.id, id)).limit(1);
  },
  /**
   * D-3: each bank's own GL account and what the BOOKS say belongs to that
   * bank — resolved through the ONE bank-identity view
   * (`journal_line_bank_identity`, migration 0073), never by re-deriving:
   *
   *   ledgerBalance       Σ Dr − Cr of every in-books cash line whose bank
   *                       identity is this bank — lines posted to its leaf
   *                       PLUS pre-per-bank history on the "Cash and Bank"
   *                       header attributed to it by the cut-over;
   *   ledgerBalanceOnLeaf the part posted to the leaf itself;
   *   attributedHistory   the part still sitting on the header, attributed.
   *
   * The split is returned, not hidden, because the balance sheet shows the
   * header's history under "Cash and Bank" and the leaf's postings under the
   * bank's name — a reader comparing the two surfaces must be able to see
   * why they differ and that they sum. `bank_accounts.balance` is still the
   * typed figure and is neither read nor written here.
   */
  async glSummary(bankAccountIds: number[]) {
    if (bankAccountIds.length === 0) return new Map<number, { glAccountId: number; glAccountName: string; ledgerBalance: string; ledgerBalanceOnLeaf: string; attributedHistory: string }>();
    const rows = await db
      .select({
        bankAccountId: categoriesTable.bankAccountId,
        glAccountId: categoriesTable.id,
        glAccountName: categoriesTable.name,
        ledgerBalanceOnLeaf: sql<string>`coalesce((
          SELECT sum(v.debit_amount - v.credit_amount)
            FROM journal_line_bank_identity v
            JOIN ${journalEntriesTable} e ON e.id = v.journal_entry_id
           WHERE v.bank_account_id = categories.bank_account_id AND v.identity_source = 'leaf' AND e.status IN ('posted','reversed')
        ), 0)::text`,
        attributedHistory: sql<string>`coalesce((
          SELECT sum(v.debit_amount - v.credit_amount)
            FROM journal_line_bank_identity v
            JOIN ${journalEntriesTable} e ON e.id = v.journal_entry_id
           WHERE v.bank_account_id = categories.bank_account_id AND v.identity_source = 'attribution' AND e.status IN ('posted','reversed')
        ), 0)::text`,
      })
      .from(categoriesTable)
      .where(inArray(categoriesTable.bankAccountId, bankAccountIds));
    return new Map(
      rows.map((r) => {
        const leaf = Number(r.ledgerBalanceOnLeaf);
        const hist = Number(r.attributedHistory);
        return [r.bankAccountId as number, { glAccountId: r.glAccountId, glAccountName: r.glAccountName, ledgerBalance: (Math.round((leaf + hist) * 100) / 100).toFixed(2), ledgerBalanceOnLeaf: r.ledgerBalanceOnLeaf, attributedHistory: r.attributedHistory }];
      }),
    );
  },
  /** How many ledger lines sit on this bank's GL account — the delete guard. */
  async ledgerLineCount(bankAccountId: number): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(journalEntryLinesTable)
      .innerJoin(categoriesTable, eq(categoriesTable.id, journalEntryLinesTable.accountId))
      .where(eq(categoriesTable.bankAccountId, bankAccountId));
    return row?.n ?? 0;
  },
  insert(values: typeof bankAccountsTable.$inferInsert) {
    return db.insert(bankAccountsTable).values(values).returning();
  },
  update(id: number, values: Partial<typeof bankAccountsTable.$inferInsert>) {
    return db.update(bankAccountsTable).set(values).where(eq(bankAccountsTable.id, id)).returning();
  },
  /**
   * Clear the default flag on every account of the current tenant except
   * `keepId`. RLS scopes the update to the tenant; the service calls this
   * before it sets a new default, so ONE effective default is a property of
   * the write boundary, not of the page.
   */
  clearDefaultsExcept(keepId: number | null) {
    return db
      .update(bankAccountsTable)
      .set({ isDefault: false })
      .where(keepId == null ? eq(bankAccountsTable.isDefault, true) : and(eq(bankAccountsTable.isDefault, true), ne(bankAccountsTable.id, keepId)));
  },
  remove(id: number) {
    return db.delete(bankAccountsTable).where(eq(bankAccountsTable.id, id));
  },
};
