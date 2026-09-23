/**
 * Phase 12A — bank statements (tenant-scoped via RLS, and company-scoped in
 * the query layer too, N1). Reads return each statement with its IMPORTED
 * count DERIVED from the lines that carry it — never a stored counter.
 */
import { db, bankStatementsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { companyScoped } from "./companyScope";

const withImported = {
  s: bankStatementsTable,
  importedCount: sql<number>`(SELECT count(*)::int FROM transactions t WHERE t.bank_statement_id = ${bankStatementsTable}."id")`,
};

export const bankStatementsRepository = {
  /** Oldest first per bank — the order continuity is judged in. */
  list(bankAccountId?: number) {
    return db
      .select(withImported)
      .from(bankStatementsTable)
      .where(and(
        companyScoped(bankStatementsTable.companyId),
        bankAccountId != null ? eq(bankStatementsTable.bankAccountId, bankAccountId) : undefined,
      ))
      .orderBy(bankStatementsTable.bankAccountId, bankStatementsTable.periodFrom, bankStatementsTable.id);
  },

  findById(id: number) {
    return db.select(withImported).from(bankStatementsTable)
      .where(and(eq(bankStatementsTable.id, id), companyScoped(bankStatementsTable.companyId))).limit(1);
  },

  findByFile(bankAccountId: number, fileSha256: string) {
    return db.select().from(bankStatementsTable)
      .where(and(
        companyScoped(bankStatementsTable.companyId),
        eq(bankStatementsTable.bankAccountId, bankAccountId),
        eq(bankStatementsTable.fileSha256, fileSha256),
      )).limit(1);
  },

  insert(values: typeof bankStatementsTable.$inferInsert) {
    return db.insert(bankStatementsTable).values(values).returning();
  },
};
