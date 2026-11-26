/**
 * 🔴 19B S6 (v4 §9, D7) — OPENING A STORED COPY. The one path from the delivery store to a reader.
 *
 * A copy is opened only by its recipient, and every open is decided again, NOW:
 *  1. not theirs — another member's, another company's, another organization's — is NOT FOUND, as a missing one is;
 *  2. EXPIRED (its time has come, whether or not the job has cleared it yet): a message and no data;
 *  3. `run` on the dataset lost since delivery: nothing opens, and the refusal is recorded against the recipient (D6);
 *  4. INTEGRITY: the content's SHA-256 is recomputed and compared with the one stored at delivery — a mismatch is
 *     refused, recorded and alarmed, and nothing of the content is shown or logged;
 *  5. each column's level is decided again for the reader's role: a class lost since delivery is withheld from the
 *     opened copy — absent from every row it applies to, and listed — though the stored copy still holds it.
 *
 * The list shows a copy's facts only (what its tombstone keeps), never its content.
 */
import { businessDate } from "@workspace/shared";
import { reportDatasetResource, type ReportDeliveryRow } from "@workspace/db";
import { alerter } from "../../lib/alerter";
import { BusinessRuleError, NotFoundError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { rowConditionApplies } from "../../lib/fieldClasses/classTable";
import { DATASETS } from "../../lib/reports/datasets";
import { columnLevel, decide, NO_USE, type Has } from "../../lib/reports/decide";
import { contentSha256, type DeliveryContent, type DeliveryWithheld } from "../../lib/reports/deliveryContent";
import { reportDeliveriesRepository } from "../../repositories/reportDeliveries.repository";
import { refusalEventsService } from "../refusalEvents.service";
import { refusalError } from "./reportDatasets.service";
import type { DefinitionActor } from "./reportDefinitions.service";

const MAX_ID = 2_147_483_647;
const isExpired = (row: { expiredAt: Date | null; expiresAt: Date }, now: Date) => row.expiredAt != null || row.expiresAt.getTime() <= now.getTime();

const facts = (row: Pick<ReportDeliveryRow, "id" | "reportName" | "dataset" | "windowFrom" | "windowTo" | "rowCount" | "createdAt" | "expiresAt" | "expiredAt">, now: Date) => ({
  id: row.id,
  reportName: row.reportName,
  dataset: row.dataset,
  status: isExpired(row, now) ? ("expired" as const) : ("available" as const),
  window: { from: row.windowFrom, to: row.windowTo },
  rowCount: row.rowCount,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
});

export const reportDeliveriesService = {
  async list(actor: DefinitionActor, now: Date = new Date()) {
    return { items: (await reportDeliveriesRepository.listMine(actor.userId)).map((r) => facts(r, now)) };
  },

  async open(id: number, actor: DefinitionActor, has: Has, now: Date = new Date()) {
    const row = Number.isSafeInteger(id) && id > 0 && id <= MAX_ID ? await reportDeliveriesRepository.findMine(id, actor.userId) : null;
    if (!row) throw new NotFoundError("Delivery not found");
    const empty = { columns: [], rows: {}, total: 0, withheld: [] };

    // 2. expired: a message, no data — whether or not the job has cleared the content yet
    if (isExpired(row, now) || row.content == null) {
      const on = businessDate(row.expiredAt ?? row.expiresAt);
      return {
        ...facts(row, now), status: "expired" as const, ...empty,
        message: `This delivery expired on ${on}. Run the report again to see current figures.`,
        messageAr: `انتهت صلاحية هذه النسخة في ${on}. شغّل التقرير مرة أخرى لعرض الأرقام الحالية.`,
      };
    }

    const refused = (refusalCode: string) =>
      refusalEventsService.record({
        action: "deliver", actorUserId: actor.userId, organizationId: actor.organizationId, companyId: actor.companyId,
        resource: reportDatasetResource(row.dataset), refusalCode, recipientUserId: actor.userId,
      });

    // 3. the dataset's `run`, for this reader, now
    const ds = DATASETS[row.dataset];
    const d = ds ? decide(has, ds, "run", NO_USE) : null;
    if (!ds || !d || !d.allowed) {
      await refused(d && !d.allowed ? d.code : "report_dataset_not_granted");
      if (d && !d.allowed) throw refusalError(d);
      throw new NotFoundError("Delivery not found");
    }

    // 4. integrity: the content as stored, against the hash taken at delivery
    if (contentSha256(row.content) !== row.contentSha256) {
      await refused("report_delivery_integrity");
      logger.error({ deliveryId: row.id }, "a stored report copy failed its integrity check — refused");
      try {
        await alerter.fire({
          key: "report-delivery-integrity",
          severity: "critical",
          title: "A stored report copy failed its integrity check",
          detail: `Delivery ${row.id} no longer matches the SHA-256 recorded when it was delivered. It was refused and nothing of it was shown. Investigate who can write to the delivery store.`,
          context: { deliveryId: row.id, dataset: row.dataset },
        });
      } catch (err) {
        logger.error({ err }, "failed to page on a report-copy integrity failure");
      }
      throw new BusinessRuleError(409, {
        code: "report_delivery_integrity",
        error: "This stored copy failed its integrity check and cannot be shown. Run the report again; your administrator has been alerted.",
        errorAr: "فشل التحقق من سلامة هذه النسخة المخزّنة ولا يمكن عرضها. شغّل التقرير مرة أخرى؛ تم تنبيه مسؤول النظام.",
      });
    }

    // 5. each column, at the level this reader holds NOW
    const content = row.content as DeliveryContent;
    const byKey = new Map(ds.columns.map((c) => [c.key, c]));
    const withheld: DeliveryWithheld[] = [...content.withheld];
    type Lost = { key: string; cls: string; applies: (r: Record<string, unknown>) => boolean };
    const lost = content.columns.flatMap((c): Lost[] => {
      const column = byKey.get(c.key);
      const now_ = column ? columnLevel(has, ds, column) : null;
      // a column the dataset no longer has cannot be classified: withheld, never served on trust
      if (!now_) return [{ key: c.key, cls: c.class, applies: () => true }];
      if (now_.level === "read") return [];
      return [{ key: c.key, cls: now_.cls, applies: (r: Record<string, unknown>) => (now_.rowCondition ? rowConditionApplies(now_.rowCondition, r) : true) }];
    });
    const lostKeys = new Map(lost.map((l) => [l.key, l]));
    const rows = content.rows.map((r) => {
      let out: Record<string, unknown> | null = null;
      for (const l of lost) if (l.key in r && l.applies(r)) { out ??= { ...r }; delete out[l.key]; }
      return out ?? r;
    });
    for (const l of lost) {
      const n = content.rows.filter((r) => l.key in r && l.applies(r)).length;
      if (n > 0 && !withheld.some((w) => w.path === `rows[].${l.key}`)) withheld.push({ path: `rows[].${l.key}`, class: l.cls, level: "none", rows: n });
    }
    const columns = content.columns.map((c) => (lostKeys.has(c.key) ? { ...c, level: "none" } : c));
    return { ...facts(row, now), columns, rows: { [row.dataset]: rows }, total: rows.length, withheld, message: null, messageAr: null };
  },
};
