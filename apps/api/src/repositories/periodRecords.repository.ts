/**
 * 🔴 T1e (DR-10): the period records — filed VAT returns, filed Zakat/income-tax
 * returns, statements authorised for issue. APPEND-ONLY: there is no update or
 * delete here, and the request's role holds neither grant (0130). Tenant-scoped
 * by RLS, company-scoped explicitly (the period-locks lesson).
 */
import { db, vatReturnFilingsTable, zakatIncomeTaxFilingsTable, statementAuthorisationsTable } from "@workspace/db";
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
