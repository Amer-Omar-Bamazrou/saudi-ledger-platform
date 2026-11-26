/**
 * 🔴 19B 19.18 — THE AUDIT TRAIL OF REPORTS: one entry in `audit_logs` for each act on a report — a saved report
 * created, changed, shared or archived; a schedule made or ended; each run, on screen or scheduled; each open of a
 * delivered copy.
 *
 * It writes to the audit trail the product already has, so these entries get what every entry gets from the database:
 * append-only for every role (0132), the actor taken from the connection and never from the writer (T1b), the time and
 * the order set by the database (0159). On top of that an entry here carries:
 *  - the COMPANY of the request (in the entry's own state, `companyId`: the trail itself stays organization-wide, as
 *    it is for every entry), and the REQUEST'S ID (the `X-Request-Id` the caller was sent; for a scheduled run,
 *    `scheduled-run:<run id>`), in its own column;
 *  - 🔴 ONCE: `(organization, request id, action, entity)` is unique in the database, and the insert steps aside on a
 *    conflict — the same request cannot record the same act twice, whatever retries it. `record` answers whether it
 *    wrote.
 *  - 🔴 NEVER A FIELD'S VALUE. An entry says what was ASKED FOR — the dataset, the column names, WHICH filters were used
 *    (their names, not their values), the period, the grouping, the counts, the paths withheld — and nothing a row
 *    holds. A report's name is the member's own text and is not recorded; its id is.
 *
 * A refused act writes nothing here: refusals have their own record (D6, `permission_refusal_events`).
 * An entry with no request to name is refused: it would not be an entry of this trail.
 */
import { auditLogsTable, db, type ReportDefinitionRow } from "@workspace/db";
import { sql } from "drizzle-orm";
import { auditContext } from "../../lib/auditContext";

export type ReportAuditEntity = "report_definition" | "report_schedule" | "report_run" | "report_scheduled_run" | "report_delivery";
export type ReportAuditAction = "create" | "update" | "share" | "archive" | "end" | "run" | "open";

export interface ReportAuditInput {
  action: ReportAuditAction;
  entityType: ReportAuditEntity;
  entityId: string | number;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/** What a saved report asks for — names only. Its filters are named, never valued; its own name is not recorded. */
export function definitionFacts(d: Pick<ReportDefinitionRow, "dataset" | "columns" | "periodKind" | "dateFrom" | "dateTo" | "filters" | "sort" | "groupBy">) {
  return {
    dataset: d.dataset,
    columns: [...d.columns],
    period: { kind: d.periodKind, from: d.dateFrom ?? null, to: d.dateTo ?? null },
    filters: Object.keys(d.filters ?? {}).sort(),
    sort: d.sort ?? null,
    groupBy: d.groupBy ?? null,
  };
}

export const reportAuditService = {
  /** Writes the entry, once per request and act. Answers false when this request had already recorded it. */
  async record(input: ReportAuditInput): Promise<boolean> {
    const ctx = auditContext.get();
    if (!ctx) throw new Error("reportAuditService.record called outside an audited request context");
    if (!ctx.requestId) throw new Error("a report audit entry needs a request id: none is bound to this context");
    const written = await db
      .insert(auditLogsTable)
      .values({
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        // 🔴 T1b: no `userId` — the row names the connection's declared actor, and the database refuses any other
        action: input.action,
        entityType: input.entityType,
        entityId: String(input.entityId),
        beforeState: input.before ?? null,
        // the company is a fact OF the entry, recorded with it — never a scoping key
        afterState: { ...(input.after ?? {}), companyId: ctx.companyId ?? null },
        ipAddress: ctx.ipAddress,
      })
      .onConflictDoNothing({
        target: [auditLogsTable.organizationId, auditLogsTable.requestId, auditLogsTable.action, auditLogsTable.entityType, auditLogsTable.entityId],
        where: sql`request_id is not null`,
      })
      .returning({ id: auditLogsTable.id });
    return written.length > 0;
  },
};
