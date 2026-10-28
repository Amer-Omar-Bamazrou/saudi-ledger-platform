/**
 * 🔴 T1e (DR-10): the period records — filed VAT returns, filed Zakat/income-tax
 * returns, statements authorised for issue. APPEND-ONLY: there is no update or
 * delete here, and the request's role holds neither grant (0130). Tenant-scoped
 * by RLS, company-scoped explicitly (the period-locks lesson).
 */
import { db, vatReturnFilingsTable, vatCorrectionsTable, zakatIncomeTaxFilingsTable, statementAuthorisationsTable } from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";

const currentCompany = sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`;

export const periodRecordsRepository = {
  vatFilings() {
    return db.select().from(vatReturnFilingsTable).where(eq(vatReturnFilingsTable.companyId, currentCompany))
      .orderBy(asc(vatReturnFilingsTable.periodFrom), asc(vatReturnFilingsTable.id));
  },
  vatFilingByReference(reference: string) {
    return db.select().from(vatReturnFilingsTable)
      .where(and(eq(vatReturnFilingsTable.companyId, currentCompany), eq(vatReturnFilingsTable.zatcaReference, reference))).limit(1);
  },
  insertVatFiling(values: typeof vatReturnFilingsTable.$inferInsert) {
    return db.insert(vatReturnFilingsTable).values(values).returning();
  },
  /** Phase 18 G2a (decisions 9–12): the errors found in this company's filed returns, append-only. */
  vatCorrections() {
    return db.select().from(vatCorrectionsTable).where(eq(vatCorrectionsTable.companyId, currentCompany))
      .orderBy(asc(vatCorrectionsTable.discoveredOn), asc(vatCorrectionsTable.id));
  },
  insertVatCorrection(values: typeof vatCorrectionsTable.$inferInsert) {
    return db.insert(vatCorrectionsTable).values(values).returning();
  },
  /**
   * Phase 18 G2a (A5(a)): the VAT-bearing entries dated in a FILED period and
   * recorded after that period's latest filing — allowed, and listed so a
   * correction can be recorded against them. VAT-bearing = a line on output or
   * input VAT or their adjustment accounts; in the books = posted or reversed.
   */
  async entriesAfterFiling() {
    const { rows } = await db.execute<{
      entryId: number; entryNumber: string; date: string; sourceType: string | null; sourceId: number | null; recordedAt: string;
      zatcaReference: string; periodFrom: string; periodTo: string; filedOn: string;
    }>(sql`
      WITH periods AS (
        SELECT o.zatca_reference, o.period_from, o.period_to, o.filed_on,
               (SELECT max(f.created_at) FROM vat_return_filings f
                 WHERE f.company_id = o.company_id AND f.period_from = o.period_from AND f.period_to = o.period_to) AS last_recorded
          FROM vat_return_filings o
         WHERE o.company_id = ${currentCompany} AND o.kind = 'original'
      )
      SELECT e.id AS "entryId", e.entry_number AS "entryNumber", e.date AS "date", e.source_type AS "sourceType", e.source_id AS "sourceId",
             e.created_at::text AS "recordedAt", p.zatca_reference AS "zatcaReference", p.period_from AS "periodFrom", p.period_to AS "periodTo",
             p.filed_on::text AS "filedOn"
        FROM journal_entries e
        JOIN periods p ON e.date >= p.period_from || '-01'
                      AND e.date < to_char(to_date(p.period_to || '-01', 'YYYY-MM-DD') + interval '1 month', 'YYYY-MM-DD')
                      AND e.created_at::timestamptz > p.last_recorded
       WHERE e.company_id = ${currentCompany} AND e.status IN ('posted', 'reversed')
         AND EXISTS (SELECT 1 FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
                      WHERE l.journal_entry_id = e.id AND c.system_code IN ('VAT_OUTPUT', 'VAT_INPUT', 'VAT_ADJ_NONPAYMENT', 'VAT_ADJ_BLOCKED'))
       ORDER BY e.date, e.id`);
    return rows;
  },
  zakatIncomeTaxFilings() {
    return db.select().from(zakatIncomeTaxFilingsTable).where(eq(zakatIncomeTaxFilingsTable.companyId, currentCompany))
      .orderBy(asc(zakatIncomeTaxFilingsTable.fiscalYearEnd), asc(zakatIncomeTaxFilingsTable.id));
  },
  zakatIncomeTaxFilingByReference(reference: string) {
    return db.select().from(zakatIncomeTaxFilingsTable)
      .where(and(eq(zakatIncomeTaxFilingsTable.companyId, currentCompany), eq(zakatIncomeTaxFilingsTable.zatcaReference, reference))).limit(1);
  },
  insertZakatIncomeTaxFiling(values: typeof zakatIncomeTaxFilingsTable.$inferInsert) {
    return db.insert(zakatIncomeTaxFilingsTable).values(values).returning();
  },
  authorisations() {
    return db.select().from(statementAuthorisationsTable).where(eq(statementAuthorisationsTable.companyId, currentCompany))
      .orderBy(asc(statementAuthorisationsTable.fiscalYearEnd));
  },
  insertAuthorisation(values: typeof statementAuthorisationsTable.$inferInsert) {
    return db.insert(statementAuthorisationsTable).values(values).returning();
  },
};
