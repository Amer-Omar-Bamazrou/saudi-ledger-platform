/** Audit logs repository — read-only queries, tenant-scoped via RLS. */
import { db, auditLogsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";

export interface AuditLogFilter {
  entityType?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

function whereFor(f: AuditLogFilter) {
  const conds = [];
  if (f.entityType) conds.push(eq(auditLogsTable.entityType, f.entityType));
  if (f.action) conds.push(eq(auditLogsTable.action, f.action));
  return conds.length > 0 ? and(...conds) : undefined;
}

export const auditLogsRepository = {
  list(f: AuditLogFilter) {
    return db
      .select()
      .from(auditLogsTable)
      .where(whereFor(f))
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(f.limit ?? 50)
      .offset(f.offset ?? 0);
  },

  count(f: AuditLogFilter) {
    return db.select({ count: sql<number>`count(*)::int` }).from(auditLogsTable).where(whereFor(f));
  },
};
