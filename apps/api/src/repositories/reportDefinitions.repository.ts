/**
 * 🔴 19B S6 — saved report definitions: every read and write of `report_definitions`. Tenant-scoped by RLS and
 * company-scoped through the reports' one seam (`companyScoped`): a definition of another company of the same
 * organization is not found here. An archived definition is never listed or found; its row stays (schedules and stored
 * deliveries name it).
 */
import { db, reportDefinitionsTable, type ReportDefinitionRow } from "@workspace/db";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { companyScoped } from "./companyScope";

const live = () => and(companyScoped(reportDefinitionsTable.companyId), isNull(reportDefinitionsTable.archivedAt));
/** Mine, or shared with my role. */
const visibleTo = (userId: number, role: string) =>
  or(eq(reportDefinitionsTable.ownerUserId, userId), sql`${role} = any(${reportDefinitionsTable.sharedRoles})`);

export type ReportDefinitionValues = Pick<ReportDefinitionRow, "name" | "dataset" | "columns" | "periodKind" | "dateFrom" | "dateTo" | "filters" | "sort">;

export const reportDefinitionsRepository = {
  listVisible(userId: number, role: string): Promise<ReportDefinitionRow[]> {
    return db.select().from(reportDefinitionsTable).where(and(live(), visibleTo(userId, role))).orderBy(asc(reportDefinitionsTable.name), asc(reportDefinitionsTable.id));
  },
  async findVisible(id: number, userId: number, role: string): Promise<ReportDefinitionRow | null> {
    const [row] = await db.select().from(reportDefinitionsTable).where(and(eq(reportDefinitionsTable.id, id), live(), visibleTo(userId, role)));
    return row ?? null;
  },
  async insert(scope: { organizationId: string; companyId: string; ownerUserId: number }, values: ReportDefinitionValues): Promise<ReportDefinitionRow> {
    const [row] = await db.insert(reportDefinitionsTable).values({ ...scope, ...values }).returning();
    return row!;
  },
  async update(id: number, values: Partial<ReportDefinitionValues> & { sharedRoles?: string[]; archivedAt?: Date }): Promise<ReportDefinitionRow> {
    const [row] = await db.update(reportDefinitionsTable).set({ ...values, updatedAt: new Date() }).where(and(eq(reportDefinitionsTable.id, id), live())).returning();
    return row!;
  },
};
