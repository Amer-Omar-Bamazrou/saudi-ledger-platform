/**
 * 🔴 19B S4 — the report datasets' reads. One query per dataset; the dataset layer (lib/reports, services/reporting/
 * reportDatasets.service.ts) decides which columns a role sees. Tenant-scoped by RLS; company-scoped through the same
 * seam the fixed reports use (`companyScoped`); "in the books" is the one definition (`JE_IN_BOOKS`: posted and reversed
 * — a reversed entry stays in the books beside its mirror).
 */
import { db, billsTable, categoriesTable, customersTable, invoicesTable, journalEntriesTable, journalEntryLinesTable, transactionsTable, vendorsTable } from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, lte, sql, type AnyColumn } from "drizzle-orm";
import { companyScoped } from "./companyScope";
import { JE_IN_BOOKS, approvedBillsOnly, approvedInvoicesOnly, documentSign } from "./reports.repository";
import { billIsPayableSql, billOutstandingSql } from "./billPosition";
// Policy C: a reversed opening item is out of every money figure — stated here as well as inside the reports' predicate.
import { billNotReversed, invoiceNotReversed } from "./openingReversal";
import { acceptedOnly, operatingOnly } from "./summary.repository";
import { textOriginSql } from "./entryTextOrigin";

export interface JournalLinesFilter { dateFrom?: string; dateTo?: string; accountId?: number; sourceType?: string }
export type JournalLinesSortKey = "date" | "entryNumber" | "accountCode" | "debit" | "credit";

export interface JournalLineRow {
  lineId: number;
  date: string;
  entryNumber: string;
  status: string;
  sourceType: string | null;
  textOrigin: string;
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
        textOrigin: textOriginSql(),
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

// ── 19B S5 — the document and cash datasets' reads ───────────────────────────────────────────────────────────────
export interface WindowFilter { dateFrom?: string; dateTo?: string }
type Sort = { key: string; desc: boolean } | null;
type Page = { limit: number; offset: number } | null;
const n2 = (v: unknown) => Number(v ?? 0);

export const documentDatasetsRepository = {
  /** Invoices, credit notes and debit notes in the books (the reports' predicate: issued, live, this company). */
  async salesDocuments(f: WindowFilter, sort: Sort, page: Page) {
    const where = and(approvedInvoicesOnly(), invoiceNotReversed(), ...(f.dateFrom ? [gte(invoicesTable.date, f.dateFrom)] : []), ...(f.dateTo ? [lte(invoicesTable.date, f.dateTo)] : []))!;
    const base = db
      .select({
        documentId: invoicesTable.id, documentNumber: invoicesTable.invoiceNumber, documentType: invoicesTable.documentType, date: invoicesTable.date,
        dueDate: invoicesTable.dueDate, status: invoicesTable.status, customerId: invoicesTable.customerId, customerName: customersTable.name,
        currency: invoicesTable.currency, subtotal: invoicesTable.subtotal, vatAmount: invoicesTable.vatAmount, total: invoicesTable.total,
        paidAmount: invoicesTable.paidAmount, isOpening: invoicesTable.isOpening,
      })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(customersTable.id, invoicesTable.customerId))
      .where(where)
      .orderBy((sort?.desc ? desc : asc)(sort?.key === "documentNumber" ? invoicesTable.invoiceNumber : invoicesTable.date), asc(invoicesTable.id));
    const raw = page ? await base.limit(page.limit).offset(page.offset) : await base;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(invoicesTable).where(where);
    return {
      total: Number(n),
      rows: raw.map((r) => {
        const sign = documentSign(r.documentType); // the ONE definition: a credit note reverses, a debit note does not
        const subtotal = n2(r.subtotal), vatAmount = n2(r.vatAmount), total = n2(r.total);
        return { ...r, date: String(r.date), subtotal, vatAmount, total, sign, signedSubtotal: sign * subtotal, signedVat: sign * vatAmount, signedTotal: sign * total, paidAmount: n2(r.paidAmount) };
      }),
    };
  },

  /** Bills and supplier notes in the books; what each still owes is billPosition's definition. */
  async purchaseDocuments(f: WindowFilter, sort: Sort, page: Page) {
    const where = and(approvedBillsOnly(), billNotReversed(), ...(f.dateFrom ? [gte(billsTable.date, f.dateFrom)] : []), ...(f.dateTo ? [lte(billsTable.date, f.dateTo)] : []))!;
    const base = db
      .select({
        documentId: billsTable.id, documentNumber: billsTable.billNumber, supplierReference: billsTable.vendorReference, documentType: billsTable.documentType,
        date: billsTable.date, dueDate: billsTable.dueDate, status: billsTable.status, vendorId: billsTable.vendorId, vendorName: vendorsTable.name,
        currency: billsTable.currency, subtotal: billsTable.subtotal, vatAmount: billsTable.vatAmount, total: billsTable.total,
        // a supplier credit note owes nothing (it is the supplier's credit, shown by the aging beside the payables)
        outstanding: sql<string>`CASE WHEN ${billIsPayableSql("bills")} THEN greatest(round(${billOutstandingSql("bills")}, 2), 0) ELSE 0 END`,
        inputVat: billsTable.inputVatState, isOpening: billsTable.isOpening,
      })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
      .where(where)
      .orderBy((sort?.desc ? desc : asc)(sort?.key === "documentNumber" ? billsTable.billNumber : billsTable.date), asc(billsTable.id));
    const raw = page ? await base.limit(page.limit).offset(page.offset) : await base;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(billsTable).where(where);
    return {
      total: Number(n),
      rows: raw.map((r) => {
        const sign = documentSign(r.documentType);
        const subtotal = n2(r.subtotal), vatAmount = n2(r.vatAmount), total = n2(r.total);
        return { ...r, date: String(r.date), subtotal, vatAmount, total, sign, signedSubtotal: sign * subtotal, signedVat: sign * vatAmount, signedTotal: sign * total, outstanding: n2(r.outstanding) };
      }),
    };
  },

  /** The bank's lines in this company; `countsInAggregates` is taxVisible's own two predicates (accepted AND operating). */
  async cashMovements(f: WindowFilter, sort: Sort, page: Page) {
    const where = and(companyScoped(transactionsTable.companyId), ...(f.dateFrom ? [gte(transactionsTable.date, f.dateFrom)] : []), ...(f.dateTo ? [lte(transactionsTable.date, f.dateTo)] : []))!;
    const base = db
      .select({
        transactionId: transactionsTable.id, date: transactionsTable.date, description: transactionsTable.description, type: transactionsTable.type,
        kind: transactionsTable.kind, amount: transactionsTable.amount, vatAmount: transactionsTable.vatAmount, reviewStatus: transactionsTable.reviewStatus,
        bankAccountId: transactionsTable.bankAccountId, categoryId: transactionsTable.categoryId, categoryName: categoriesTable.name,
        countsInAggregates: sql<boolean>`(${acceptedOnly()} AND ${operatingOnly()})`,
      })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(categoriesTable.id, transactionsTable.categoryId))
      .where(where)
      .orderBy((sort?.desc ? desc : asc)(transactionsTable.date), asc(transactionsTable.id));
    const raw = page ? await base.limit(page.limit).offset(page.offset) : await base;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(transactionsTable).where(where);
    return {
      total: Number(n),
      rows: raw.map((r) => {
        const amount = n2(r.amount);
        return { ...r, date: String(r.date), amount, signedAmount: r.type === "credit" ? amount : -amount, vatAmount: r.vatAmount == null ? null : n2(r.vatAmount), countsInAggregates: r.countsInAggregates === true };
      }),
    };
  },
};
