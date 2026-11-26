/**
 * 🔴 19B S6 (v4 §6.2; scope 19.14) — REPORT SCHEDULES, as a member makes and ends them.
 *
 *  - A schedule is made on a saved report the member may see, on a cadence, for RECIPIENTS who are active members of
 *    the same organization. With no recipients named it is for the member alone.
 *  - THE ACTS: scheduling to oneself needs the dataset's `schedule` act; naming anyone else also needs `deliver`
 *    (v4 §6.2: a viewer schedules to themselves only). A refused schedule is RECORDED (D6) — names only — and answered.
 *  - Delivering to others never widens access: each recipient is checked against THEIR OWN grants when the run is
 *    delivered, and again whenever they open their copy (reportSchedules.job.ts, reportDeliveries.service.ts).
 *  - RECIPIENTS are picked and shown by NAME and ROLE only — for every role, the admin included: no email.
 *  - A schedule is its owner's: only they see it or end it; anyone else gets 404. Ended, never deleted.
 */
import { REPORT_CADENCES, reportDatasetResource, type ReportCadence } from "@workspace/db";
import { BusinessRuleError, NotFoundError } from "../../lib/errors";
import { DATASETS } from "../../lib/reports/datasets";
import type { Has } from "../../lib/reports/decide";
import { membersRepository } from "../../repositories/members.repository";
import { reportSchedulesRepository } from "../../repositories/reportSchedules.repository";
import { refusalEventsService } from "../refusalEvents.service";
import { reportAuditService } from "./reportAudit.service";
import { refusalError } from "./reportDatasets.service";
import { decideDefinition, reportDefinitionsService, type DefinitionActor } from "./reportDefinitions.service";

const MAX_RECIPIENTS = 50;
const MAX_ID = 2_147_483_647;
const bad = (error: string, errorAr: string) => new BusinessRuleError(400, { code: "report_bad_filter", error, errorAr });
const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= MAX_ID;

type Member = { name: string; role: string; active: boolean };
const person = (userId: number, m: Member | undefined) => ({ userId, name: m?.name ?? `#${userId}`, role: m?.role ?? "" });

export const reportSchedulesService = {
  /** The members a report can be delivered to: active members of this organization, by name and role. */
  async recipients(actor: DefinitionActor) {
    const members = await membersRepository.namesAndRoles(actor.organizationId);
    const items = [...members.entries()].filter(([, m]) => m.active).map(([userId, m]) => person(userId, m)).sort((a, b) => a.name.localeCompare(b.name) || a.userId - b.userId);
    return { items };
  },

  async list(actor: DefinitionActor) {
    const rows = await reportSchedulesRepository.listMine(actor.userId);
    const ids = rows.map((r) => r.schedule.id);
    const [recipients, runs] = [await reportSchedulesRepository.recipients(ids), await reportSchedulesRepository.lastRuns(ids)];
    const members = await membersRepository.namesAndRoles(actor.organizationId, [...new Set([...recipients.values()].flat())]);
    return {
      items: rows.map(({ schedule, reportName, dataset }) => {
        const run = runs.get(schedule.id);
        return {
          id: schedule.id,
          definitionId: schedule.definitionId,
          reportName,
          dataset,
          cadence: schedule.cadence,
          recipients: (recipients.get(schedule.id) ?? []).map((u) => person(u, members.get(u))),
          createdAt: schedule.createdAt.toISOString(),
          lastRun: run
            ? { periodKey: run.periodKey, status: run.status, outcomeCode: run.outcomeCode, deliveredCount: run.deliveredCount, skippedCount: run.skippedCount, finishedAt: run.finishedAt?.toISOString() ?? null }
            : null,
        };
      }),
    };
  },

  async create(body: unknown, actor: DefinitionActor, has: Has) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    // the report first: one the member cannot see is not found, whatever else the request says
    const definition = await reportDefinitionsService.visibleRow(isId(b.definitionId) ? b.definitionId : 0, actor, has);
    if (typeof b.cadence !== "string" || !(REPORT_CADENCES as readonly string[]).includes(b.cadence)) {
      throw bad(`Choose how often the report runs: ${REPORT_CADENCES.join(", ")}.`, "اختر تكرار تشغيل التقرير: يومي أو أسبوعي أو شهري.");
    }
    const raw = b.recipientUserIds ?? [actor.userId];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RECIPIENTS || !raw.every(isId) || new Set(raw).size !== raw.length) {
      throw bad(`Recipients are a list of up to ${MAX_RECIPIENTS} members, each once.`, `المستلمون قائمة لا تتجاوز ${MAX_RECIPIENTS} عضواً، كل منهم مرة واحدة.`);
    }
    const recipientIds = raw as number[];
    const ds = DATASETS[definition.dataset];
    if (!ds) throw new NotFoundError("Report not found");

    // the acts: schedule, and deliver when anyone but the member is named — refused by name, and recorded (D6)
    for (const act of recipientIds.some((u) => u !== actor.userId) ? (["schedule", "deliver"] as const) : (["schedule"] as const)) {
      const d = decideDefinition(has, ds, act, definition);
      if (!d.allowed) {
        if (d.status === 403) {
          await refusalEventsService.record({
            action: "schedule", actorUserId: actor.userId, organizationId: actor.organizationId, companyId: actor.companyId,
            resource: reportDatasetResource(ds.name), refusalCode: d.code,
            fieldNames: d.fields.map((f) => f.field), fieldClasses: d.fields.map((f) => f.class),
          });
        }
        throw refusalError(d);
      }
    }
    const members = await membersRepository.namesAndRoles(actor.organizationId, recipientIds);
    if (recipientIds.some((u) => members.get(u)?.active !== true)) {
      throw new BusinessRuleError(422, {
        code: "report_recipient_not_member",
        error: "A report can be delivered only to active members of this organization. Choose recipients from the list.",
        errorAr: "لا يُرسل التقرير إلا لأعضاء نشطين في هذه المنشأة. اختر المستلمين من القائمة.",
      });
    }
    if (!actor.companyId) throw new BusinessRuleError(422, { code: "company_required", error: "Create a company before scheduling a report.", errorAr: "أنشئ منشأة قبل جدولة تقرير." });
    const row = await reportSchedulesRepository.insert({ organizationId: actor.organizationId, companyId: actor.companyId, ownerUserId: actor.userId }, definition.id, b.cadence as ReportCadence, recipientIds);
    // 19.18: who is to receive it is recorded by id — a name is the member's, and the picker's to show
    await reportAuditService.record({ action: "create", entityType: "report_schedule", entityId: row.id, after: { definitionId: definition.id, dataset: definition.dataset, cadence: row.cadence, recipients: [...recipientIds].sort((a, b) => a - b) } });
    return {
      id: row.id, definitionId: definition.id, reportName: definition.name, dataset: definition.dataset, cadence: row.cadence,
      recipients: recipientIds.map((u) => person(u, members.get(u))), createdAt: row.createdAt.toISOString(), lastRun: null,
    };
  },

  /** Ended by its owner: it runs no more. Its runs and the copies already delivered stay. */
  async end(id: number, actor: DefinitionActor): Promise<void> {
    const row = isId(id) ? await reportSchedulesRepository.findMine(id, actor.userId) : null;
    if (!row) throw new NotFoundError("Schedule not found");
    await reportSchedulesRepository.end(row.id);
    await reportAuditService.record({ action: "end", entityType: "report_schedule", entityId: row.id, before: { definitionId: row.definitionId, cadence: row.cadence } });
  },
};
