/**
 * 🔴 Phase 18 G4b (WHT decisions 17, 18): the refund-claim and instalment-request
 * records and their events — APPEND-ONLY (0140 grants SELECT and INSERT). There
 * is no update or delete here. Tenant-scoped by RLS, company-scoped explicitly.
 */
import { db, whtRefundClaimsTable, whtRefundClaimEventsTable, whtInstalmentRequestsTable, whtInstalmentRequestEventsTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

const currentCompany = sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`;

export const whtClaimsRepository = {
  refundClaims() {
    return db.select().from(whtRefundClaimsTable).where(eq(whtRefundClaimsTable.companyId, currentCompany)).orderBy(desc(whtRefundClaimsTable.id));
  },
  refundClaim(id: number) {
    return db.select().from(whtRefundClaimsTable).where(and(eq(whtRefundClaimsTable.companyId, currentCompany), eq(whtRefundClaimsTable.id, id))).limit(1);
  },
  insertRefundClaim(values: typeof whtRefundClaimsTable.$inferInsert) {
    return db.insert(whtRefundClaimsTable).values(values).returning();
  },
  refundClaimEvents(claimIds: number[]) {
    if (claimIds.length === 0) return Promise.resolve([]);
    return db.select().from(whtRefundClaimEventsTable).where(inArray(whtRefundClaimEventsTable.claimId, claimIds)).orderBy(asc(whtRefundClaimEventsTable.id));
  },
  insertRefundClaimEvent(values: typeof whtRefundClaimEventsTable.$inferInsert) {
    return db.insert(whtRefundClaimEventsTable).values(values).returning();
  },
  instalmentRequests() {
    return db.select().from(whtInstalmentRequestsTable).where(eq(whtInstalmentRequestsTable.companyId, currentCompany)).orderBy(desc(whtInstalmentRequestsTable.id));
  },
  instalmentRequest(id: number) {
    return db.select().from(whtInstalmentRequestsTable).where(and(eq(whtInstalmentRequestsTable.companyId, currentCompany), eq(whtInstalmentRequestsTable.id, id))).limit(1);
  },
  insertInstalmentRequest(values: typeof whtInstalmentRequestsTable.$inferInsert) {
    return db.insert(whtInstalmentRequestsTable).values(values).returning();
  },
  instalmentRequestEvents(requestIds: number[]) {
    if (requestIds.length === 0) return Promise.resolve([]);
    return db.select().from(whtInstalmentRequestEventsTable).where(inArray(whtInstalmentRequestEventsTable.requestId, requestIds)).orderBy(asc(whtInstalmentRequestEventsTable.id));
  },
  insertInstalmentRequestEvent(values: typeof whtInstalmentRequestEventsTable.$inferInsert) {
    return db.insert(whtInstalmentRequestEventsTable).values(values).returning();
  },
};
