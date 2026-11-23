/**
 * 🔴 19B S4 — the report datasets' reads. One query per dataset; the dataset layer (lib/reports, services/reporting/
 * reportDatasets.service.ts) decides which columns a role sees. Tenant-scoped by RLS; company-scoped through the same
 * seam the fixed reports use (`companyScoped`); "in the books" is the one definition (`JE_IN_BOOKS`: posted and reversed
 * — a reversed entry stays in the books beside its mirror).
 */
import { db, categoriesTable, journalEntriesTable, journalEntryLinesTable } from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, lte, sql, type AnyColumn } from "drizzle-orm";
import { companyScoped } from "./companyScope";
import { JE_IN_BOOKS } from "./reports.repository";

export interface JournalLinesFilter { dateFrom?: string; dateTo?: string; accountId?: number; sourceType?: string }
export type JournalLinesSortKey = "date" | "entryNumber" | "accountCode" | "debit" | "credit";

export interface JournalLineRow {
  lineId: number;
  date: string;
  entryNumber: string;
  status: string;
  sourceType: string | null;
  reference: string | null;
  accountId: number | null;
  accountCode: string | null;
  accountName: string;
  accountNameAr: string | null;
  description: string | null;
  debit: number;
  credit: number;
}

const SORT: Record<JournalLinesSortKey, AnyColumn> = {
  date: journalEntriesTable.date,
  entryNumber: journalEntriesTable.entryNumber,
  accountCode: categoriesTable.accountCode,
  debit: journalEntryLinesTable.debitAmount,
  credit: journalEntryLinesTable.creditAmount,
};

function where(f: JournalLinesFilter) {
  const conds = [inArray(journalEntriesTable.status, JE_IN_BOOKS), companyScoped(journalEntriesTable.companyId)];
  if (f.dateFrom) conds.push(gte(journalEntriesTable.date, f.dateFrom));
  if (f.dateTo) conds.push(lte(journalEntriesTable.date, f.dateTo));
  if (f.accountId != null) conds.push(eq(journalEntryLinesTable.accountId, f.accountId));
  if (f.sourceType) conds.push(eq(journalEntriesTable.sourceType, f.sourceType as never));
  return and(...conds)!;
}

export const reportDatasetsRepository = {
  /** The page of lines, and the TRUE count of lines the filter selects (never a capped list's length). */
  async journalLines(f: JournalLinesFilter, sort: { key: JournalLinesSortKey; desc: boolean } | null, page: { limit: number; offset: number } | null): Promise<{ rows: JournalLineRow[]; total: number }> {
    const order = sort ? [(sort.desc ? desc : asc)(SORT[sort.key])] : [];
    const base = db
      .select({
        lineId: journalEntryLinesTable.id,
        date: journalEntriesTable.date,
        entryNumber: journalEntriesTable.entryNumber,
        status: journalEntriesTable.status,
        sourceType: journalEntriesTable.sourceType,
        reference: journalEntriesTable.reference,
        accountId: journalEntryLinesTable.accountId,
        accountCode: categoriesTable.accountCode,
        accountName: journalEntryLinesTable.accountName,
        accountNameAr: categoriesTable.nameAr,
        description: journalEntryLinesTable.description,
        debit: journalEntryLinesTable.debitAmount,
        credit: journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .leftJoin(categoriesTable, eq(categoriesTable.id, journalEntryLinesTable.accountId))
      .where(where(f))
      .orderBy(...order, asc(journalEntriesTable.date), asc(journalEntriesTable.id), asc(journalEntryLinesTable.id));
    const raw = page ? await base.limit(page.limit).offset(page.offset) : await base;
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(where(f));
    return {
      rows: raw.map((r) => ({ ...r, date: String(r.date), sourceType: r.sourceType ?? null, debit: Number(r.debit ?? 0), credit: Number(r.credit ?? 0) })),
      total: Number(n),
    };
  },
};
