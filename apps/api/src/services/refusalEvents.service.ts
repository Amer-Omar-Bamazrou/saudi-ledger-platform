/**
 * 🔴 19B S4 — D6, THE REFUSAL EVENT (v4 §8): a refused export, schedule, schedule run, delivery, or field write is
 * recorded — who, when, which act on which resource, the refusal's code, and the NAMES and classes of the fields — so
 * the trail can answer "who tried to take what". A refused run, and a field withheld from an ordinary read, are not.
 *
 *  - 🔴 NEVER A VALUE. `RefusalEventInput` has no field that could carry a value, a filter's operand or a body, and the
 *    table has no column for one (migration 0171). A test plants a known value and asserts it is nowhere in the row.
 *  - ON ITS OWN CONNECTION: the owner's, outside the refused request's transaction — which rolls back, and would take
 *    the record with it. The table is owner-only, as `security_audit_logs` is.
 *  - A FAILED WRITE never changes the refusal: it is logged and ALARMED (an unrecorded refusal is a gap in the trail
 *    nobody would otherwise see), and the caller answers the refusal as it would have.
 */
import { ownerDb, permissionRefusalEventsTable, type RefusalEventAction } from "@workspace/db";
import { alerter } from "../lib/alerter";
import { logger } from "../lib/logger";
import { requestContext } from "../lib/requestContext";

export interface RefusalEventInput {
  action: RefusalEventAction;
  actorUserId: number | null;
  organizationId: string;
  companyId: string | null;
  /** The dataset, the report, or the record's resource — by name. */
  resource: string;
  refusalCode: string;
  /** Names only. */
  fieldNames?: readonly string[];
  fieldClasses?: readonly string[];
  recipientUserId?: number | null;
}

/** The write itself — a seam a test can make fail. */
export const refusalEventsStore = {
  async insert(row: typeof permissionRefusalEventsTable.$inferInsert): Promise<void> {
    await ownerDb.insert(permissionRefusalEventsTable).values(row);
  },
};

export const refusalEventsService = {
  /** Record a refusal. Never throws: a failure is logged and alarmed, and the refusal stands. */
  async record(e: RefusalEventInput): Promise<void> {
    try {
      await refusalEventsStore.insert({
        requestId: requestContext.get()?.requestId ?? null,
        actorUserId: e.actorUserId,
        organizationId: e.organizationId,
        companyId: e.companyId,
        action: e.action,
        resource: e.resource,
        refusalCode: e.refusalCode,
        fieldNames: [...new Set(e.fieldNames ?? [])],
        fieldClasses: [...new Set(e.fieldClasses ?? [])],
        recipientUserId: e.recipientUserId ?? null,
      });
    } catch (err) {
      logger.error({ action: e.action, resource: e.resource, refusalCode: e.refusalCode, err }, "refusal-event write FAILED — refusal not recorded");
      try {
        await alerter.fire({
          key: "refusal-event-write-failed",
          severity: "critical",
          title: "A refusal event failed to record",
          detail: `A refused '${e.action}' on '${e.resource}' (${e.refusalCode}) could not be written to permission_refusal_events. The refusal stood; the trail has a gap. Investigate the table and the events around this time.`,
          context: { action: e.action, resource: e.resource, refusalCode: e.refusalCode },
        });
      } catch (alertErr) {
        logger.error({ err: alertErr }, "failed to page on a refusal-event write failure");
      }
    }
  },
};
