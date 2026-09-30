/**
 * Phase 13B S1 — the historical VAT declarations of opening payables, and their
 * evidence. Tenant-scoped through RLS like every repository here; the rules
 * live in `services/openingVatDeclarations.service.ts` and, as the boundary,
 * in migration 0110 (append-only, complete at commit, tenant-consistent).
 * Every read is scoped to the CURRENT COMPANY as well (N1): a two-company
 * organisation declares each company's payables in that company's books.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  billsTable,
  migrationBatchesTable,
  migrationOpenItemsTable,
  openingPayableVatDeclarationsTable,
  openingPayableVatDeclarationEvidenceTable,
} from "@workspace/db";
import { companyScoped } from "./companyScope";

export const openingVatDeclarationsRepository = {
  /** A migrated open item with the status and opening date of its batch. */
  async findItem(itemId: number) {
    const [row] = await db
      .select({
        id: migrationOpenItemsTable.id,
        itemType: migrationOpenItemsTable.itemType,
        documentNumber: migrationOpenItemsTable.documentNumber,
        historicalVat: migrationOpenItemsTable.historicalVat,
        originalAmount: migrationOpenItemsTable.originalAmount,
        batchId: migrationOpenItemsTable.batchId,
        batchStatus: migrationBatchesTable.status,
        openingDate: migrationBatchesTable.openingDate,
      })
      .from(migrationOpenItemsTable)
      .innerJoin(migrationBatchesTable, eq(migrationBatchesTable.id, migrationOpenItemsTable.batchId))
      .where(and(eq(migrationOpenItemsTable.id, itemId), companyScoped(migrationOpenItemsTable.companyId)));
    return row ?? null;
  },

  /** The LIVE opening bill of a migrated item — the last replacement in its chain, not reversed. */
  async liveBillForItem(itemId: number) {
    const [row] = await db
      .select()
      .from(billsTable)
      .where(and(eq(billsTable.migrationOpenItemId, itemId), isNull(billsTable.reversedAt), eq(billsTable.isOpening, true), companyScoped(billsTable.companyId)));
    return row ?? null;
  },

  async findByItem(itemId: number) {
    const [row] = await db.select().from(openingPayableVatDeclarationsTable).where(and(eq(openingPayableVatDeclarationsTable.migrationOpenItemId, itemId), companyScoped(openingPayableVatDeclarationsTable.companyId)));
    return row ?? null;
  },

  async list() {
    return db.select().from(openingPayableVatDeclarationsTable).where(companyScoped(openingPayableVatDeclarationsTable.companyId)).orderBy(asc(openingPayableVatDeclarationsTable.id));
  },

  async evidenceFor(declarationIds: number[]) {
    if (declarationIds.length === 0) return [];
    return db
      .select()
      .from(openingPayableVatDeclarationEvidenceTable)
      .where(and(inArray(openingPayableVatDeclarationEvidenceTable.declarationId, declarationIds), companyScoped(openingPayableVatDeclarationEvidenceTable.companyId)))
      .orderBy(asc(openingPayableVatDeclarationEvidenceTable.id));
  },

  async insert(values: typeof openingPayableVatDeclarationsTable.$inferInsert) {
    const [row] = await db.insert(openingPayableVatDeclarationsTable).values(values).returning();
    return row!;
  },

  async insertEvidence(values: Array<typeof openingPayableVatDeclarationEvidenceTable.$inferInsert>) {
    if (values.length === 0) return [];
    return db.insert(openingPayableVatDeclarationEvidenceTable).values(values).returning();
  },
};
