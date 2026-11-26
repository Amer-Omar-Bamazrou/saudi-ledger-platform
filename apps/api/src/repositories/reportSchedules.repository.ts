/**
 * 🔴 19B S6 — report schedules, as the request's role reads and writes them: a member's own schedules in the request's
 * company, their recipients, and the last run of each. Tenant-scoped by RLS, company-scoped through the reports' seam.
 * A schedule is ENDED, never deleted; a schedule whose report was archived is not listed (it runs no more).
 */
import { db, reportDefinitionsTable, reportRunsTable, reportScheduleRecipientsTable, reportSchedulesTable, type ReportCadence, type ReportRunRow, type ReportScheduleRow } from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { companyScoped } from "./companyScope";

const live = () => and(companyScoped(reportSchedulesTable.companyId), isNull(reportSchedulesTable.endedAt));

export interface ScheduleWithReport { schedule: ReportScheduleRow; reportName: string; dataset: string }

export const reportSchedulesRepository = {
  async insert(scope: { organizationId: string; companyId: string; ownerUserId: number }, definitionId: number, cadence: ReportCadence, recipientUserIds: number[]): Promise<ReportScheduleRow> {
    const [row] = await db.insert(reportSchedulesTable).values({ ...scope, definitionId, cadence }).returning();
    await db.insert(reportScheduleRecipientsTable).values(recipientUserIds.map((userId) => ({ scheduleId: row!.id, organizationId: scope.organizationId, companyId: scope.companyId, userId })));
    return row!;
  },

  listMine(userId: number): Promise<ScheduleWithReport[]> {
    return db
      .select({ schedule: reportSchedulesTable, reportName: reportDefinitionsTable.name, dataset: reportDefinitionsTable.dataset })
      .from(reportSchedulesTable)
      .innerJoin(reportDefinitionsTable, eq(reportDefinitionsTable.id, reportSchedulesTable.definitionId))
      .where(and(live(), eq(reportSchedulesTable.ownerUserId, userId), isNull(reportDefinitionsTable.archivedAt)))
      .orderBy(asc(reportSchedulesTable.id));
  },

  async findMine(id: number, userId: number): Promise<ReportScheduleRow | null> {
    const [row] = await db.select().from(reportSchedulesTable).where(and(eq(reportSchedulesTable.id, id), live(), eq(reportSchedulesTable.ownerUserId, userId)));
    return row ?? null;
  },

  async end(id: number): Promise<void> {
    await db.update(reportSchedulesTable).set({ endedAt: new Date() }).where(and(eq(reportSchedulesTable.id, id), live()));
  },

  async recipients(scheduleIds: number[]): Promise<Map<number, number[]>> {
    const out = new Map<number, number[]>();
    if (scheduleIds.length === 0) return out;
    const rows = await db.select({ scheduleId: reportScheduleRecipientsTable.scheduleId, userId: reportScheduleRecipientsTable.userId }).from(reportScheduleRecipientsTable).where(inArray(reportScheduleRecipientsTable.scheduleId, scheduleIds));
    for (const r of rows) out.set(r.scheduleId, [...(out.get(r.scheduleId) ?? []), r.userId]);
    return out;
  },

  /** The latest run of each schedule (the job writes runs; the request's role reads them). */
  async lastRuns(scheduleIds: number[]): Promise<Map<number, ReportRunRow>> {
    const out = new Map<number, ReportRunRow>();
    if (scheduleIds.length === 0) return out;
    const rows = await db.select().from(reportRunsTable).where(inArray(reportRunsTable.scheduleId, scheduleIds)).orderBy(desc(reportRunsTable.id));
    for (const r of rows) if (!out.has(r.scheduleId)) out.set(r.scheduleId, r);
    return out;
  },
};
