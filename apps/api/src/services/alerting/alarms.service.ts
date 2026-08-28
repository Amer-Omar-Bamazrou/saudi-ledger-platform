/**
 * B2 — the alarms themselves. One pass evaluates every platform condition,
 * pages on the ones that are firing, and clears the ones that stopped.
 *
 * ── The two conditions, and why they are the two ───────────────────────────
 * Both fail by QUIET NEGLECT — nothing rejects, nothing errors, and the screen
 * stays green while the damage accrues. That is precisely the shape an
 * operator panel cannot catch, and the reason B2 blocks onboarding a real
 * taxpayer:
 *
 *   1. **outbox-overdue** — documents sitting unsubmitted. ZATCA gives
 *      simplified invoices a 24-HOUR reporting deadline, so the alarm keys off
 *      the OLDEST document's age, not the count: one document 23 hours old is
 *      a bigger emergency than fifty that are ten minutes old.
 *   2. **pcsid-expiring** — a signing certificate inside its final window (or
 *      already expired). B1 emails the TENANT (only they can renew, with an
 *      OTP from their own Fatoora portal); this pages US, because a tenant who
 *      ignores three emails is still our incident when signing stops.
 *
 * ── Dedupe is a row, not a timer ───────────────────────────────────────────
 * `alert_state` holds one row per condition. A firing condition re-pages at
 * most every `ALERT_REPEAT_HOURS`; when it clears, the row is deleted and a
 * resolve notice goes out. A channel that never says "clear" trains people to
 * ignore it, which is the same disease as a panel that is always green.
 */
import { loadEnv } from "@workspace/config";
import { ownerDb } from "@workspace/db";
import { sql } from "drizzle-orm";
import { alerter, type Alert } from "../../lib/alerter";
import { logger } from "../../lib/logger";
import { einvoiceOutboxRepository } from "../../repositories/einvoiceOutbox.repository";
import { renewalService, REMINDER_THRESHOLDS_DAYS } from "../einvoice/renewal/renewal.service";
import { lastSuccessfulReset, demoTenantCreatedAt } from "../demo/demoReset.service";

export const ALARM_OUTBOX_OVERDUE = "outbox-overdue";
export const ALARM_PCSID_EXPIRING = "pcsid-expiring";
/**
 * DEMO ONLY (D9). Evaluated to a no-op unless `DEMO_MODE`, and it is here
 * rather than in the demo code because this is where quiet neglect gets a voice
 * — and a stalled demo reset is exactly that shape: nothing errors, the page
 * keeps loading, and the banner keeps promising a weekly wipe that stopped
 * happening. The alarm is what turns "we schedule a reset" into "the reset
 * happened", which is the difference between a claim and a fact.
 */
export const ALARM_DEMO_RESET_OVERDUE = "demo-reset-overdue";

/**
 * Every condition this service evaluates.
 *
 * Exported so tests assert "the loop completed" against THIS LIST rather than
 * against a literal 2 — a hard-coded count is a figure derived from reasoning,
 * and it went stale the moment a third alarm was added (which is exactly how it
 * was found). The list is still hand-maintained alongside the array below; what
 * it removes is the count drifting silently in two files at once.
 */
export const ALL_ALARM_KEYS = [
  ALARM_OUTBOX_OVERDUE,
  ALARM_PCSID_EXPIRING,
  ALARM_DEMO_RESET_OVERDUE,
] as const;

export interface AlarmRunResult {
  evaluated: number;
  firing: string[];
  paged: string[];
  resolved: string[];
}

/** The final reminder window — inside it, an unrenewed certificate is our problem. */
const CRITICAL_EXPIRY_DAYS = Math.min(...REMINDER_THRESHOLDS_DAYS);

async function record(alert: Alert, repeatHours: number): Promise<"paged" | "suppressed"> {
  // One statement decides fire-vs-suppress, so two instances evaluating at once
  // cannot both page: the loser's UPDATE matches zero rows.
  const { rows } = await ownerDb.execute<{ paged: boolean }>(sql`
    INSERT INTO alert_state (key, severity, title, first_fired_at, last_fired_at, fire_count)
    VALUES (${alert.key}, ${alert.severity}, ${alert.title}, now(), now(), 1)
    ON CONFLICT (key) DO UPDATE
      SET last_fired_at = now(),
          fire_count    = alert_state.fire_count + 1,
          severity      = EXCLUDED.severity,
          title         = EXCLUDED.title
      WHERE alert_state.last_fired_at < now() - (${String(repeatHours)} || ' hours')::interval
    RETURNING true AS paged
  `);
  return rows.length > 0 ? "paged" : "suppressed";
}

/**
 * Record first, then page. If the webhook is down the row still says we tried,
 * so the next pass suppresses instead of storming — an alerting outage must
 * not become a second incident.
 */
async function fireIfDue(alert: Alert, repeatHours: number): Promise<boolean> {
  if ((await record(alert, repeatHours)) !== "paged") return false;
  logger.warn({ alarm: alert.key, severity: alert.severity }, alert.title);
  const { sent } = await alerter.fire(alert);
  if (!sent) {
    await ownerDb.execute(sql`UPDATE alert_state SET last_sent = false WHERE key = ${alert.key}`);
  } else {
    await ownerDb.execute(sql`UPDATE alert_state SET last_sent = true WHERE key = ${alert.key}`);
  }
  return true;
}

/** Minutes since a document was enqueued — `created_at` is not on OutboxRow. */
async function ageMinutesOf(documentId: string): Promise<number> {
  const { rows } = await ownerDb.execute<{ minutes: string }>(sql`
    SELECT EXTRACT(EPOCH FROM (now() - created_at)) / 60 AS minutes
      FROM einvoice_documents WHERE id = ${documentId}
  `);
  return rows[0] ? Math.floor(Number(rows[0].minutes)) : 0;
}

async function clearIfPresent(key: string, title: string): Promise<boolean> {
  const { rows } = await ownerDb.execute<{ key: string }>(sql`
    DELETE FROM alert_state WHERE key = ${key} RETURNING key
  `);
  if (rows.length === 0) return false;
  await alerter.resolve(key, title);
  return true;
}

export const alarmsService = {
  /**
   * Evaluate every alarm once. Never throws: a monitoring pass that dies takes
   * the monitoring with it, which is worse than the condition it was watching.
   *
   * `organizationId` restricts evaluation to ONE organization. Omitted in
   * production, where this is a platform job watching every tenant. It exists
   * because evaluation is deliberately CROSS-TENANT and global — the same
   * escape hatch as the outbox worker's, for the same reason: in the test
   * suite, one suite's aged documents or expiring credentials fire another
   * suite's alarm assertions.
   */
  async runOnce(opts: { organizationId?: string } = {}): Promise<AlarmRunResult> {
    const env = loadEnv();
    const result: AlarmRunResult = { evaluated: 0, firing: [], paged: [], resolved: [] };

    const alarms: Array<() => Promise<void>> = [
      // ── 1. Outbox age ──────────────────────────────────────────────────
      async () => {
        /**
         * 🔴 2026-08-28 — the COUNT is counted in SQL; the page is only for the
         * oldest row.
         *
         * This alarm said `${overdue.length} document(s) unsubmitted` off a
         * 500-capped page, so any backlog past 500 paged the words "500
         * document(s)" — forever, however bad it got. An alarm that
         * under-reports the condition it exists to detect is quiet neglect
         * (queue B2) wearing the costume of a working alarm, and this is the one
         * that watches ZATCA's 24-hour reporting deadline.
         *
         * Invisible at fixture scale by construction: below 500 the two numbers
         * are identical. `tests/scale-and-collision.test.ts` builds 537.
         */
        const [overdue, overdueTotal] = await Promise.all([
          einvoiceOutboxRepository.listOverdue(env.ZATCA_OVERDUE_MINUTES, 500, opts.organizationId),
          einvoiceOutboxRepository.countOverdue(env.ZATCA_OVERDUE_MINUTES, opts.organizationId),
        ]);
        if (overdueTotal === 0) {
          if (await clearIfPresent(ALARM_OUTBOX_OVERDUE, "E-invoice outbox is draining again")) {
            result.resolved.push(ALARM_OUTBOX_OVERDUE);
          }
          return;
        }
        // listOverdue orders by created_at, so the first row is the oldest.
        // The count and the page share one predicate, so a positive total always
        // yields a row; the guard states that rather than assuming it — an alarm
        // must never be the thing that throws.
        const oldest = overdue[0];
        if (!oldest) return;
        const ageMinutes = await ageMinutesOf(oldest.id);
        const hours = Math.floor(ageMinutes / 60);
        result.firing.push(ALARM_OUTBOX_OVERDUE);
        const paged = await fireIfDue(
          {
            key: ALARM_OUTBOX_OVERDUE,
            // Past 12 hours the 24-hour reporting deadline is genuinely at risk.
            severity: hours >= 12 ? "critical" : "warning",
            title: `E-invoice outbox stuck — oldest document ${hours}h old`,
            detail:
              `${overdueTotal} document(s) unsubmitted; the oldest has waited ${hours}h ${ageMinutes % 60}m. ` +
              `ZATCA requires simplified invoices to be REPORTED within 24 hours — past that the tenant is ` +
              `exposed to fines from SAR 5,000. Check the worker is running and the ZATCA API is reachable.`,
            context: { total: overdueTotal, oldestAgeMinutes: ageMinutes, oldestDocumentId: oldest.id },
          },
          env.ALERT_REPEAT_HOURS,
        );
        if (paged) result.paged.push(ALARM_OUTBOX_OVERDUE);
      },

      // ── 2. Certificate expiry ──────────────────────────────────────────
      async () => {
        const DAY_MS = 24 * 60 * 60 * 1000;
        const now = Date.now();
        // `listExpiring` returns everything inside the window; an already-
        // EXPIRED certificate is included deliberately — silence after expiry
        // is the worst case, since that is exactly when signing has stopped.
        const expiring = (await renewalService.listExpiring(CRITICAL_EXPIRY_DAYS, opts.organizationId))
          .filter((c) => c.notAfter != null)
          .map((c) => ({ ...c, daysRemaining: Math.floor((c.notAfter!.getTime() - now) / DAY_MS) }));
        if (expiring.length === 0) {
          if (await clearIfPresent(ALARM_PCSID_EXPIRING, "No ZATCA certificate is in its final renewal window")) {
            result.resolved.push(ALARM_PCSID_EXPIRING);
          }
          return;
        }
        const worst = expiring.reduce((a, b) => (a.daysRemaining <= b.daysRemaining ? a : b));
        result.firing.push(ALARM_PCSID_EXPIRING);
        const paged = await fireIfDue(
          {
            key: ALARM_PCSID_EXPIRING,
            severity: worst.daysRemaining <= 0 ? "critical" : "warning",
            title:
              worst.daysRemaining <= 0
                ? `ZATCA certificate EXPIRED — signing has stopped for ${expiring.length} company/companies`
                : `ZATCA certificate expires in ${worst.daysRemaining} days`,
            detail:
              `${expiring.length} credential(s) at or inside the T-${CRITICAL_EXPIRY_DAYS} window. ` +
              `Renewal needs an OTP from the TENANT's own Fatoora portal — we cannot do it for them, ` +
              `so this needs a human chasing the tenant, not a retry. At expiry they cannot legally invoice.`,
            context: { credentials: expiring.length, worstDaysRemaining: worst.daysRemaining },
          },
          env.ALERT_REPEAT_HOURS,
        );
        if (paged) result.paged.push(ALARM_PCSID_EXPIRING);
      },

      // ── 3. Demo reset overdue (DEMO_MODE only) ─────────────────────────
      async () => {
        if (!env.DEMO_MODE) {
          // Not a demo: make sure a stale row from a previous configuration
          // does not keep paging. Clearing is cheap and no-ops when absent.
          if (await clearIfPresent(ALARM_DEMO_RESET_OVERDUE, "Not a demo deployment")) {
            result.resolved.push(ALARM_DEMO_RESET_OVERDUE);
          }
          return;
        }
        const DAY_MS = 24 * 60 * 60 * 1000;
        const last = await lastSuccessfulReset();
        const intervalDays = env.DEMO_RESET_INTERVAL_DAYS;
        // One interval to fall due, plus a full day of grace before paging —
        // the job runs hourly, so a day late means it is not running at all,
        // not that it is running slightly behind.
        const overdueAfterDays = intervalDays + 1;
        const ageDays =
          last === null ? null : Math.floor((Date.now() - last.getTime()) / DAY_MS);

        // "Never reset" is NOT an alarm on its own — a demo deployed today has
        // legitimately never reset. The clock starts when the demo TENANT was
        // created, which is the moment the banner started making the claim.
        // (Deriving it from the tenant rather than from a recorded attempt also
        // catches the worst case: a job that never ran even once, and so left
        // no attempt behind to measure.)
        const tenantAge = await demoTenantCreatedAt();
        const neverButOverdue =
          last === null &&
          tenantAge !== null &&
          Date.now() - tenantAge.getTime() > overdueAfterDays * DAY_MS;

        if (!neverButOverdue && (ageDays === null || ageDays < overdueAfterDays)) {
          if (
            await clearIfPresent(ALARM_DEMO_RESET_OVERDUE, "Demo reset is running on schedule")
          ) {
            result.resolved.push(ALARM_DEMO_RESET_OVERDUE);
          }
          return;
        }

        result.firing.push(ALARM_DEMO_RESET_OVERDUE);
        const paged = await fireIfDue(
          {
            key: ALARM_DEMO_RESET_OVERDUE,
            severity: "warning",
            title:
              last === null
                ? "Demo reset has NEVER succeeded"
                : `Demo reset is ${ageDays} days old (interval ${intervalDays}d)`,
            detail:
              `The demo banner tells every viewer the sample data is wiped every ${intervalDays} days. ` +
              `That claim is now false: ` +
              (last === null
                ? `no reset has ever completed successfully.`
                : `the last successful reset was ${ageDays} days ago.`) +
              ` Check demo_reset_runs for the failing run's detail — a refusal means DEMO_MODE is set ` +
              `on a database holding tenants that are not the demo, which is the more serious case.`,
            context: { lastSuccessfulReset: last?.toISOString() ?? null, intervalDays },
          },
          env.ALERT_REPEAT_HOURS,
        );
        if (paged) result.paged.push(ALARM_DEMO_RESET_OVERDUE);
      },
    ];

    for (const alarm of alarms) {
      result.evaluated += 1;
      try {
        await alarm();
      } catch (err) {
        logger.error({ err }, "alarm evaluation failed");
      }
    }

    return result;
  },
};
