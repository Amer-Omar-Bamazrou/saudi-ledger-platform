/**
 * Scheduled findings (AI-5) — the platform job that runs every organization's
 * checks on its cadence and delivers the result on the owner's decided
 * channels (2026-08-24).
 *
 * ── The push ladder, exactly as decided ────────────────────────────────────
 * 1. A scheduled run with open findings sends ONE email — counts and a
 *    pointer only, never finding contents — to the org's ACTIVE ADMINS (they
 *    own the review; acknowledge is approver-only).
 * 2. 🔴 There is NO second email, ever. "Email escalating into more email is
 *    a longer parking space." After ESCALATION_AFTER_DAYS unviewed, the
 *    run's condition becomes a persistent Dashboard marker (derived by
 *    `findingsService.status`, rendered by the web) that stands until
 *    someone opens the findings — opening is the dismissal.
 * 3. Nothing auto-acknowledges, at any age. A finding that ages out would be
 *    a silent default aging into being trusted.
 *
 * 🔴 THE HONEST LIMIT, RECORDED PLAINLY: with no external escalation target,
 * the chain ends where the tenant's attention ends. The product makes
 * ignoring harder (the marker) and records that a run was never opened
 * (`viewed_at` stays NULL, queryable) — it cannot make someone read, and a
 * tenant who never logs in is never reached past the one email.
 *
 * ── Mechanics ──────────────────────────────────────────────────────────────
 * Cadence: CALENDAR quarters by default, months on opt-in (M20.2's
 * reasoning — the filing rhythm, and the only definition an
 * undeclared-fiscal-year tenant has). The run row for (org, period) is the
 * CLAIM, inserted before the work on the owner connection (the recurring-job
 * discipline): a concurrent instance's insert conflicts and stops.
 *
 * Owner-connection use here is the platform-job pattern (alarms/renewal/
 * recurring): iterating organizations is exactly the identity-layer read
 * those jobs are sanctioned for, and the checks themselves still run inside
 * a per-org TENANT transaction so RLS scopes every query.
 */
import { ownerDb, beginTenantConnection } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { auditContext } from "../lib/auditContext";
import { mailer } from "../lib/mailer";
import { membersRepository } from "../repositories/members.repository";
import { findingsRepository } from "../repositories/findings.repository";
import { findingsService } from "./findings.service";

export type Cadence = "quarterly" | "monthly";

/** '2026-Q3' / '2026-08' — the period a date falls in, calendar-based. */
export function periodKeyFor(cadence: Cadence, date: Date): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  return cadence === "monthly" ? `${y}-${String(m).padStart(2, "0")}` : `${y}-Q${Math.ceil(m / 3)}`;
}

export interface ScheduledFindingsResult {
  due: number;
  ran: number;
  alreadyRun: number;
  emailed: number;
  failed: number;
}

export const findingsScheduleService = {
  async runOnce(now: Date = new Date(), onlyOrganizationId?: string): Promise<ScheduledFindingsResult> {
    const result: ScheduledFindingsResult = { due: 0, ran: 0, alreadyRun: 0, emailed: 0, failed: 0 };

    // Orgs with at least one company — an org without one holds no business
    // rows, so there is nothing to check and no period to claim.
    const { rows: orgs } = await ownerDb.execute<{ id: string; cadence: Cadence | null }>(sql`
      SELECT o.id, fs.cadence
        FROM organizations o
        LEFT JOIN finding_schedules fs ON fs.organization_id = o.id
       WHERE EXISTS (SELECT 1 FROM companies c WHERE c.organization_id = o.id)
         ${onlyOrganizationId ? sql`AND o.id = ${onlyOrganizationId}` : sql``}
    `);

    for (const org of orgs) {
      const cadence: Cadence = org.cadence ?? "quarterly";
      const periodKey = periodKeyFor(cadence, now);

      // The CLAIM — before any work. A losing concurrent instance conflicts
      // here and stops; the winner's row is later updated with the counts.
      const { rows: claim } = await ownerDb.execute<{ id: number }>(sql`
        INSERT INTO finding_runs (organization_id, period_key, trigger)
        VALUES (${org.id}, ${periodKey}, 'scheduled')
        ON CONFLICT (organization_id, period_key) DO NOTHING
        RETURNING id
      `);
      if (claim.length === 0) {
        result.alreadyRun += 1;
        continue;
      }
      result.due += 1;
      const runId = claim[0].id;

      try {
        const conn = await beginTenantConnection({ organizationId: org.id, role: "authenticated" });
        let summary;
        try {
          summary = await conn.run(() =>
            auditContext.run({ userId: null, organizationId: org.id, ipAddress: null }, () =>
              findingsService.run({ recordRun: false }),
            ),
          );
          await conn.commit();
        } catch (err) {
          await conn.rollback();
          throw err;
        }

        await ownerDb.execute(sql`
          UPDATE finding_runs
             SET created = ${summary.created}, reopened = ${summary.reopened},
                 refreshed = ${summary.refreshed}, resolved = ${summary.resolved},
                 open_after = ${summary.open}
           WHERE id = ${runId}
        `);
        result.ran += 1;

        // One email, to the owners of the review — and only when there is
        // something open. "All clear" quarterly mail trains inattention
        // toward the mail that matters; the run row still records it ran.
        if (summary.open > 0) {
          const admins = await membersRepository.activeAdminEmails(org.id);
          let delivered = 0;
          for (const to of admins) {
            const r = await mailer.send({
              to,
              subject: `Findings ready for review — ${summary.open} open (${periodKey}) | ملاحظات بانتظار المراجعة`,
              text:
                `The scheduled review of your records ran for ${periodKey}.\n` +
                `${summary.open} finding(s) are open (${summary.created} new, ${summary.reopened} returned).\n` +
                `Open the Findings page in the app to review them. These are observations about your own records — duplicates, overdue documents, waiting drafts — not tax or compliance verdicts.\n\n` +
                `اكتمل الفحص المجدول لسجلاتكم للفترة ${periodKey}.\n` +
                `${summary.open} ملاحظة مفتوحة (${summary.created} جديدة). افتحوا صفحة «الملاحظات» في التطبيق لمراجعتها.\n\n` +
                `You will not receive a second email about this run. If it stays unopened, a notice will appear on your dashboard instead.`,
            });
            if (r.delivered) delivered += 1;
          }
          // Record the truth: emailed_at marks the ATTEMPT window; the count
          // is deliveries the provider accepted (a no-provider dev
          // environment records 0 — visible, not assumed).
          await ownerDb.execute(sql`
            UPDATE finding_runs SET emailed_at = now(), emailed_count = ${delivered} WHERE id = ${runId}
          `);
          // Stamp the announced findings (owner Q3: a finding records where
          // it was sent) — inside the tenant scope.
          const conn2 = await beginTenantConnection({ organizationId: org.id, role: "authenticated" });
          try {
            await conn2.run(() => findingsRepository.markDeliveredEmailNotice(runId));
            await conn2.commit();
          } catch (err) {
            await conn2.rollback();
            throw err;
          }
          if (delivered > 0) result.emailed += 1;
          if (admins.length === 0) {
            // The B1 posture: a notice with no resolvable recipient is logged
            // loudly, never silently skipped.
            logger.warn({ organizationId: org.id, runId }, "scheduled findings: no active admin to email — in-app only");
          }
        }
      } catch (err) {
        result.failed += 1;
        logger.error({ err, organizationId: org.id, periodKey }, "scheduled findings run failed");
      }
    }

    if (result.ran > 0 || result.failed > 0) {
      logger.info(result, "scheduled findings pass complete");
    }
    return result;
  },
};
