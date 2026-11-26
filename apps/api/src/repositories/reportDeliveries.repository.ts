/**
 * 🔴 19B S6 (v4 §9, D7) — THE IN-APP DELIVERY STORE. 🔴 THE ONLY FILE THAT TOUCHES `report_deliveries`
 * (tests/s6-report-schedules-deliveries.test.ts lists every source file naming the table and fails on a second one).
 *
 *  - READS run as the request's role, under RLS and the company seam, and only ever for the RECIPIENT: a copy that is
 *    another member's, another company's or another organization's is not found — the same answer as a missing one.
 *    The request's role holds SELECT on the table and nothing else.
 *  - WRITES are the job's alone, on the owner connection: a copy is inserted at delivery, and at expiry its CONTENT IS
 *    CLEARED (the tombstone stays: id, report, recipient, created, expired, hash). Nothing here deletes a row, and no
 *    route reaches either write.
 *  - There is no file, no link and no export of the store: a copy is a row, served through the one endpoint that
 *    re-checks the recipient's grants at every open.
 */
import { db, ownerDb, reportDeliveriesTable, type ReportDeliveryRow } from "@workspace/db";
import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import { companyScoped } from "./companyScope";

const mine = (userId: number) => and(companyScoped(reportDeliveriesTable.companyId), eq(reportDeliveriesTable.recipientUserId, userId));

/** A copy's facts without its content — what a list shows, and what the tombstone keeps. */
const FACTS = {
  id: reportDeliveriesTable.id,
  reportName: reportDeliveriesTable.reportName,
  dataset: reportDeliveriesTable.dataset,
  windowFrom: reportDeliveriesTable.windowFrom,
  windowTo: reportDeliveriesTable.windowTo,
  rowCount: reportDeliveriesTable.rowCount,
  createdAt: reportDeliveriesTable.createdAt,
  expiresAt: reportDeliveriesTable.expiresAt,
  expiredAt: reportDeliveriesTable.expiredAt,
} as const;

export interface NewDeliveryCopy {
  organizationId: string;
  companyId: string;
  runId: number;
  definitionId: number;
  recipientUserId: number;
  reportName: string;
  dataset: string;
  windowFrom: string | null;
  windowTo: string | null;
  rowCount: number;
  content: unknown;
  contentSha256: string;
  expiresAt: Date;
}

export const reportDeliveriesRepository = {
  /** The recipient's copies, newest first — facts only, never the content. */
  listMine(userId: number) {
    return db.select(FACTS).from(reportDeliveriesTable).where(mine(userId)).orderBy(desc(reportDeliveriesTable.createdAt), desc(reportDeliveriesTable.id)).limit(200);
  },

  /** One copy, with its content, for its recipient only. */
  async findMine(id: number, userId: number): Promise<ReportDeliveryRow | null> {
    const [row] = await db.select().from(reportDeliveriesTable).where(and(eq(reportDeliveriesTable.id, id), mine(userId)));
    return row ?? null;
  },

  /** THE JOB'S: store one recipient's copy (owner connection). A second copy for the same run and recipient is refused by the table. */
  async insertCopy(copy: NewDeliveryCopy): Promise<number> {
    const [row] = await ownerDb.insert(reportDeliveriesTable).values(copy).returning({ id: reportDeliveriesTable.id });
    return row!.id;
  },

  /** THE JOB'S: clear the content of every copy whose time has come, keeping its tombstone (owner connection). */
  async expireDue(now: Date): Promise<number> {
    const rows = await ownerDb
      .update(reportDeliveriesTable)
      .set({ content: null, expiredAt: now })
      .where(and(lte(reportDeliveriesTable.expiresAt, now), isNotNull(reportDeliveriesTable.content)))
      .returning({ id: reportDeliveriesTable.id });
    return rows.length;
  },
};
