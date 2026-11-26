/**
 * 🔴 19B S6 (v4 §6.2, §8 D6, §9 D7; scope 19.14) — THE SCHEDULED-REPORTS JOB, AND THE COPIES' EXPIRY.
 *
 * ── A run ──────────────────────────────────────────────────────────────────────────────────────────────────────────
 *  1. THE CLAIM, before any work: one row per (schedule, period), inserted on the owner connection. A second process —
 *     or a second tick the same business day — conflicts on the unique key and stops. One run per period.
 *  2. AS THE OWNER, re-resolved NOW: the owner's membership and role are read again at run time. An owner who is no
 *     longer an active member, or whose role has lost the act, runs nothing: the run is REFUSED and recorded (D6).
 *  3. PER RECIPIENT, re-resolved NOW: each recipient's own role decides THEIR copy. One who is no longer a member, or
 *     whose role may not run the dataset (or may not read a column the report filters or sorts by), is SKIPPED and
 *     recorded. Everyone else gets a copy holding only the cells their own role may read — a field they may not see is
 *     never written into their copy; the copy lists it as withheld.
 *  4. The rows are read ONCE, inside a tenant transaction for the schedule's organization and company (RLS and the
 *     company seam scope every query), by the same read the screen and the export use.
 *  5. Too many rows is a FAILED run with the count's code — a copy is never cut short.
 *
 * The period is the BUSINESS day's (`businessDate`, Asia/Riyadh): a daily schedule runs once per business day, a weekly
 * one once per week starting Sunday, a monthly one once per calendar month — at the first tick of that period.
 *
 * ── Expiry ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * A copy's content is CLEARED when its time comes; the tombstone stays. 🔴 The retention is a PROPOSAL until the
 * privacy adviser answers B3 (v4 §9): one named constant, here.
 *
 * Owner-connection use is the platform-job pattern (findings.schedule.service.ts): the job reads schedules across
 * organizations and writes the runs and the copies, which the request's role may only read.
 */
import { ownerDb, beginTenantConnection, reportDatasetResource, type ReportCadence } from "@workspace/db";
import { businessDate, businessDateShift, resolveReportPeriod, type ReportPeriodKind } from "@workspace/shared";
import { sql } from "drizzle-orm";
import { auditContext } from "../../lib/auditContext";
import { logger } from "../../lib/logger";
import { getPermissions } from "../../lib/rbac";
import { DATASETS, type DatasetRow } from "../../lib/reports/datasets";
import type { Has } from "../../lib/reports/decide";
import { contentSha256, type DeliveryContent } from "../../lib/reports/deliveryContent";
import { membersRepository } from "../../repositories/members.repository";
import { reportDeliveriesRepository } from "../../repositories/reportDeliveries.repository";
import { refusalEventsService } from "../refusalEvents.service";
import { cellVisible, datasetColumnOut, groupedOut, orderByGroup, parseRequest, readDataset, requireWindow, withheldTotalsOut } from "./reportDatasets.service";
import { groupRows } from "../../lib/reports/grouping";
import { decideDefinition, definitionQuery } from "./reportDefinitions.service";
import { reportAuditService } from "./reportAudit.service";
import { DATASET_EXPORT_MAX_ROWS } from "./reportExport.service";

/** 🔴 A PROPOSAL (v4 §9, D7): 90 days, until the privacy adviser answers B3. Change it here and nowhere else. */
export const REPORT_DELIVERY_RETENTION_DAYS_PROPOSED = 90;

/** The period a schedule's run is FOR on a business day: the day, the week's Sunday, or the month. */
export function schedulePeriodKey(cadence: ReportCadence, businessDay: string): string {
  if (cadence === "monthly") return businessDay.slice(0, 7);
  if (cadence === "daily") return businessDay;
  const [y, m, d] = businessDay.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday, the business week's first day
  return `W${businessDateShift(businessDay, -weekday)}`;
}

interface DueSchedule extends Record<string, unknown> {
  id: number; organization_id: string; company_id: string; owner_user_id: number; cadence: ReportCadence; definition_id: number;
  name: string; dataset: string; columns: string[]; period_kind: ReportPeriodKind; date_from: string | null; date_to: string | null;
  filters: Record<string, string>; sort: string | null; group_by: string | null;
}

export interface ScheduledReportsResult { due: number; alreadyRun: number; delivered: number; skipped: number; refused: number; failed: number }

async function finish(runId: number, status: "delivered" | "refused" | "failed", outcomeCode: string | null, delivered = 0, skipped = 0): Promise<void> {
  await ownerDb.execute(sql`
    UPDATE report_runs SET status = ${status}, outcome_code = ${outcomeCode}, delivered_count = ${delivered}, skipped_count = ${skipped}, finished_at = now()
     WHERE id = ${runId}`);
}

/**
 * 🔴 19.18 — THE RUN'S OWN AUDIT ENTRY, whatever became of it (delivered, refused, failed), written once it has
 * finished: which schedule and report, for whom (the owner), for which period, with which outcome, and each named
 * recipient's outcome — by id. Its request id is the RUN's (`scheduled-run:<id>`), and a run is claimed once per period,
 * so the entry is written once however often, and in however many processes, the job ticks. A system connection: the
 * entry has no acting user (the job acted), and names the owner in its own words.
 */
async function recordRun(s: DueSchedule, runId: number): Promise<void> {
  const { rows: [run] } = await ownerDb.execute<{ status: string; outcome_code: string | null; period_key: string; window_from: string | null; window_to: string | null; delivered_count: number; skipped_count: number }>(sql`
    SELECT status, outcome_code, period_key, window_from::text AS window_from, window_to::text AS window_to, delivered_count, skipped_count
      FROM report_runs WHERE id = ${runId}`);
  if (!run) return;
  const { rows: named } = await ownerDb.execute<{ user_id: number }>(sql`SELECT user_id FROM report_schedule_recipients WHERE schedule_id = ${s.id} ORDER BY user_id`);
  const got = new Set(await reportDeliveriesRepository.recipientsOfRun(runId));
  const conn = await beginTenantConnection({ organizationId: s.organization_id, companyId: s.company_id, role: "authenticated" });
  try {
    await conn.run(() =>
      auditContext.run({ userId: null, organizationId: s.organization_id, ipAddress: null, requestId: `scheduled-run:${runId}`, companyId: s.company_id }, () =>
        reportAuditService.record({
          action: "run", entityType: "report_scheduled_run", entityId: runId,
          after: {
            scheduleId: Number(s.id), definitionId: Number(s.definition_id), ownerUserId: Number(s.owner_user_id), cadence: s.cadence, periodKey: run.period_key,
            dataset: s.dataset, columns: [...s.columns], filters: Object.keys(s.filters ?? {}).sort(), sort: s.sort ?? null, groupBy: s.group_by ?? null,
            window: { from: run.window_from, to: run.window_to },
            status: run.status, outcomeCode: run.outcome_code, delivered: Number(run.delivered_count), skipped: Number(run.skipped_count),
            recipients: named.map((n) => ({ userId: Number(n.user_id), outcome: got.has(Number(n.user_id)) ? "delivered" : "not_delivered" })),
          },
        }),
      ),
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

async function runSchedule(s: DueSchedule, runId: number, window: { from: string; to: string }, now: Date, result: ScheduledReportsResult): Promise<void> {
  const ds = DATASETS[s.dataset];
  const definition = { columns: s.columns, filters: s.filters, sort: s.sort, groupBy: s.group_by };
  const grants = await getPermissions();
  const hasFor = (role: string): Has => (resource, action) => grants.has(`${role}:${resource}:${action}`);
  const resource = reportDatasetResource(s.dataset);
  const event = (action: "schedule_run" | "deliver", refusalCode: string, recipientUserId?: number, fields: { field: string; class: string }[] = []) =>
    refusalEventsService.record({
      action, actorUserId: s.owner_user_id, organizationId: s.organization_id, companyId: s.company_id, resource, refusalCode,
      fieldNames: fields.map((f) => f.field), fieldClasses: fields.map((f) => f.class), recipientUserId: recipientUserId ?? null,
    });
  const refuse = async (code: string, fields: { field: string; class: string }[] = []) => {
    await event("schedule_run", code, undefined, fields);
    await finish(runId, "refused", code);
    result.refused += 1;
  };

  const { rows: recipientRows } = await ownerDb.execute<{ user_id: number }>(sql`SELECT user_id FROM report_schedule_recipients WHERE schedule_id = ${s.id} ORDER BY user_id`);
  const recipientIds = recipientRows.map((r) => Number(r.user_id));
  const members = await membersRepository.namesAndRoles(s.organization_id, [...new Set([s.owner_user_id, ...recipientIds])]);

  // 2. as the owner, now
  const owner = members.get(s.owner_user_id);
  if (!ds) return refuse("report_unknown_dataset");
  if (!owner?.active) return refuse("report_schedule_owner_not_member");
  for (const act of recipientIds.some((u) => u !== s.owner_user_id) ? (["schedule", "deliver"] as const) : (["schedule"] as const)) {
    const d = decideDefinition(hasFor(owner.role), ds, act, definition);
    if (!d.allowed) return refuse(d.code, d.fields);
  }

  // 3. each recipient, now — decided before anything is read
  const decided: { userId: number; columns: Extract<ReturnType<typeof decideDefinition>, { allowed: true }> }[] = [];
  let skipped = 0;
  for (const userId of recipientIds) {
    const m = members.get(userId);
    if (!m?.active) { await event("deliver", "report_recipient_not_member", userId); skipped += 1; continue; }
    const d = decideDefinition(hasFor(m.role), ds, "run", definition);
    if (!d.allowed) { await event("deliver", d.code, userId, d.fields); skipped += 1; continue; }
    decided.push({ userId, columns: d });
  }

  // 4. the rows, once, under the schedule's own tenant scope
  let rows: DatasetRow[] = [];
  if (decided.length > 0) {
    const { filter, sort } = parseRequest(ds, definitionQuery(definition, window), false);
    requireWindow(ds, filter);
    // a SYSTEM connection (T1b: only the request path declares an actor). It reads and writes nothing; the schedule's
    // owner is named where it matters — on the run, and on every refusal event.
    const conn = await beginTenantConnection({ organizationId: s.organization_id, companyId: s.company_id, role: "authenticated" });
    try {
      const read = await conn.run(() =>
        auditContext.run({ userId: null, organizationId: s.organization_id, ipAddress: null }, async () => {
          const { total } = await readDataset(ds, filter, sort, { limit: 1, offset: 0 });
          return total > DATASET_EXPORT_MAX_ROWS ? null : (await readDataset(ds, filter, sort, null)).rows;
        }),
      );
      await conn.commit();
      if (read === null) {
        // 5. never cut short
        await finish(runId, "failed", "export_too_large", 0, skipped);
        result.failed += 1;
        return;
      }
      rows = read;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const expiresAt = new Date(now.getTime() + REPORT_DELIVERY_RETENTION_DAYS_PROPOSED * 86_400_000);
  // 19.12: a grouped report's copy carries its rows group by group, and the subtotals THIS recipient may have
  if (s.group_by) rows = orderByGroup(ds, s.group_by, rows);
  for (const { userId, columns: d } of decided) {
    const grouped = s.group_by ? groupRows(ds, s.group_by, d.columns, rows) : null;
    const content: DeliveryContent = {
      dataset: ds.name,
      columns: d.columns.map(datasetColumnOut),
      // 🔴 a cell this recipient may not read is never written into their copy
      rows: rows.map((r) => {
        const o: Record<string, unknown> = {};
        for (const c of d.columns) if (cellVisible(c, r)) o[c.column.key] = r[c.column.key] ?? null;
        return o;
      }),
      total: rows.length,
      withheld: [
        ...d.withheld.map((c) => ({ path: `rows[].${c.column.key}`, class: c.cls, level: c.level === "last4" ? "last4" : "none", rows: rows.filter((r) => !cellVisible(c, r)).length })),
        ...(grouped ? withheldTotalsOut(grouped) : []),
      ],
      ...(grouped ? { grouped: groupedOut(grouped) } : {}),
    };
    // hashed as it will be stored: through JSON, so a Date or an undefined cannot make the stored form differ
    const stored = JSON.parse(JSON.stringify(content)) as DeliveryContent;
    await reportDeliveriesRepository.insertCopy({
      organizationId: s.organization_id, companyId: s.company_id, runId, definitionId: s.definition_id, recipientUserId: userId,
      reportName: s.name, dataset: ds.name, windowFrom: window.from, windowTo: window.to, rowCount: stored.rows.length,
      content: stored, contentSha256: contentSha256(stored), expiresAt,
    });
  }
  await finish(runId, "delivered", null, decided.length, skipped);
  result.delivered += decided.length;
  result.skipped += skipped;
}

export const reportSchedulesJob = {
  async runOnce(now: Date = new Date(), onlyOrganizationId?: string): Promise<ScheduledReportsResult> {
    const result: ScheduledReportsResult = { due: 0, alreadyRun: 0, delivered: 0, skipped: 0, refused: 0, failed: 0 };
    const today = businessDate(now);
    const { rows: schedules } = await ownerDb.execute<DueSchedule>(sql`
      SELECT s.id, s.organization_id, s.company_id, s.owner_user_id, s.cadence, s.definition_id,
             d.name, d.dataset, d.columns, d.period_kind, d.date_from::text AS date_from, d.date_to::text AS date_to, d.filters, d.sort, d.group_by
        FROM report_schedules s
        JOIN report_definitions d ON d.id = s.definition_id AND d.organization_id = s.organization_id
       WHERE s.ended_at IS NULL AND d.archived_at IS NULL
         ${onlyOrganizationId ? sql`AND s.organization_id = ${onlyOrganizationId}` : sql``}
       ORDER BY s.id`);

    for (const s of schedules) {
      const periodKey = schedulePeriodKey(s.cadence, today);
      const window = resolveReportPeriod({ kind: s.period_kind, from: s.date_from, to: s.date_to }, today);
      // 1. THE CLAIM — before any work. A losing concurrent instance conflicts here and stops.
      const { rows: claim } = await ownerDb.execute<{ id: number }>(sql`
        INSERT INTO report_runs (organization_id, company_id, schedule_id, period_key, window_from, window_to)
        VALUES (${s.organization_id}, ${s.company_id}, ${s.id}, ${periodKey}, ${window?.from ?? null}, ${window?.to ?? null})
        ON CONFLICT (schedule_id, period_key) DO NOTHING
        RETURNING id`);
      if (claim.length === 0) { result.alreadyRun += 1; continue; }
      result.due += 1;
      const runId = Number(claim[0]!.id);
      try {
        if (!window) {
          await finish(runId, "failed", "report_bad_filter");
          result.failed += 1;
        } else {
          await runSchedule(s, runId, window, now, result);
        }
      } catch (err) {
        logger.error({ err, scheduleId: s.id, runId }, "a scheduled report run failed");
        await finish(runId, "failed", "internal_error").catch((e) => logger.error({ err: e, runId }, "could not record a failed scheduled report run"));
        result.failed += 1;
      }
      // 19.18: the run's audit entry, once it has finished — whatever its outcome. The run row above is already
      // durable; a failure here is loud in the log and leaves the run itself as the record.
      await recordRun(s, runId).catch((err) => logger.error({ err, scheduleId: s.id, runId }, "a scheduled report run was not written to the audit trail"));
    }
    if (result.due > 0) logger.info({ ...result }, "scheduled reports: run finished");
    return result;
  },
};

export const reportDeliveryExpiryJob = {
  /** Clears the content of every stored copy whose time has come; the tombstones stay. */
  async runOnce(now: Date = new Date()): Promise<{ expired: number }> {
    const expired = await reportDeliveriesRepository.expireDue(now);
    if (expired > 0) logger.info({ expired }, "stored report copies expired: content cleared, tombstones kept");
    return { expired };
  },
};
