/**
 * PCSID expiry reminders — T-90 / T-30 / T-7 (M12.8).
 *
 * ── Why this needs an alarm rather than a dashboard ─────────────────────────
 * Confirmed empirically on 2026-08-09: ZATCA's CA issues certificates valid for
 * exactly 5 years with NO grace period. At expiry, signing stops dead — the
 * tenant cannot clear or report invoices, and therefore cannot legally invoice
 * at all. Nothing looks wrong beforehand. It is quiet neglect, not a loud
 * rejection, which is exactly the failure shape a dashboard does not catch.
 *
 * ── 🔴 LEAD TIME IS THE WHOLE POINT: WE CANNOT FIX A LATE REMINDER ──────────
 * Renewal requires the TENANT's own action — a fresh CSR plus an OTP they must
 * generate in their own Fatoora portal. We never see or hold their ERAD
 * credentials, by design. So unlike almost every other alert on this platform,
 * a reminder that fires late cannot be remediated by us at all. That asymmetry
 * is why three thresholds exist instead of one, and why the earliest is 90 days.
 *
 * ── 🔴 AND THE MAILER IS CURRENTLY A NO-OP ─────────────────────────────────
 * `lib/mailer.ts` still exports `noopMailer`, which logs and returns
 * `delivered: false`. Email is attempted and its outcome RECORDED rather than
 * assumed, because an absent reminder is worse than a late one here. Until a
 * provider is integrated, the reminder reaches a human only through the in-app
 * ZATCA page and the operator view — both of which read the rows this job
 * writes, so the reminder is never merely a log line.
 */
import { ownerDb, zatcaCredentialRemindersTable, companiesTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "../../../lib/logger";
import { mailer } from "../../../lib/mailer";
import { membersRepository } from "../../../repositories/members.repository";
import { signingService } from "../signing/signing.service";

/** The reminder windows, widest first — the order they are presented in. */
export const REMINDER_THRESHOLDS_DAYS = [90, 30, 7] as const;

/**
 * The same windows, TIGHTEST first — the order they must be SEARCHED in.
 *
 * Kept as a separate constant rather than reversing inline, because the two
 * orders mean different things and confusing them is a real bug: searching
 * widest-first announces a certificate with 5 days left as a T-90 notice.
 */
const ASCENDING_THRESHOLDS = [...REMINDER_THRESHOLDS_DAYS].sort((a, b) => a - b);

export interface RenewalReminder {
  credentialId: string;
  companyId: string;
  environment: string;
  notAfter: Date;
  thresholdDays: number;
  daysRemaining: number;
}

export interface RenewalCheckResult {
  expiringCredentials: number;
  remindersRaised: number;
  alreadyRaised: number;
}

const DAY_MS = 86_400_000;

export const renewalService = {
  /**
   * Raise any reminder that is now due and has not been raised before.
   *
   * Idempotency is a UNIQUE INDEX on (credential_id, threshold_days), not a
   * scheduling assumption — two API instances running this job must not send
   * duplicate warnings about a certificate that stops signing, or the tenant
   * learns to ignore them.
   *
   * `organizationId` restricts the pass to one organization — omitted in
   * production (the job watches every tenant), passed by tests so one suite's
   * synthetic expiry dates do not raise reminders inside another suite's run.
   * The same escape hatch as the outbox worker's, for the same reason.
   */
  async runOnce(now: Date = new Date(), organizationId?: string): Promise<RenewalCheckResult> {
    // One query at the widest threshold; the buckets are decided in memory.
    const widest = Math.max(...REMINDER_THRESHOLDS_DAYS);
    const expiring = await signingService.listExpiring(widest, organizationId);

    const result: RenewalCheckResult = {
      expiringCredentials: expiring.length,
      remindersRaised: 0,
      alreadyRaised: 0,
    };

    for (const cred of expiring) {
      if (!cred.notAfter) continue;

      const daysRemaining = Math.floor((cred.notAfter.getTime() - now.getTime()) / DAY_MS);
      // The TIGHTEST threshold this credential has crossed — searched ASCENDING.
      //
      // 🔴 Searching the exported (descending) array would return the widest
      // crossed window instead: with 5 days left, `[90,30,7].find(t => 5 <= t)`
      // is 90, so a certificate about to expire would be announced as a T-90
      // notice. The reminder would fire, look correct, and understate the
      // urgency by twelve weeks — and because the row is written per
      // (credential, threshold), the real T-7 reminder would still be pending
      // while the T-90 slot was already consumed.
      //
      // An already-expired certificate (negative days) still matches 7, because
      // silence after expiry is the worst possible behaviour: that is exactly
      // when the tenant cannot invoice.
      const threshold = ASCENDING_THRESHOLDS.find((t) => daysRemaining <= t);
      if (threshold === undefined) continue;

      const raised = await raiseReminder(
        {
          credentialId: cred.credentialId,
          companyId: cred.companyId,
          environment: cred.environment,
          notAfter: cred.notAfter,
          thresholdDays: threshold,
          daysRemaining,
        },
        now,
      );
      if (raised) result.remindersRaised += 1;
      else result.alreadyRaised += 1;
    }

    if (result.remindersRaised > 0) {
      logger.warn(result, "ZATCA certificate renewal reminders raised");
    }
    return result;
  },

  /** Reminders already raised, for the operator view and the tenant's ZATCA page. */
  async listRaised(companyIds?: string[]) {
    const q = ownerDb.select().from(zatcaCredentialRemindersTable);
    if (companyIds && companyIds.length > 0) {
      return q.where(inArray(zatcaCredentialRemindersTable.companyId, companyIds));
    }
    return q;
  },

  /** Everything expiring inside `days`, whether or not a reminder was raised. */
  listExpiring(days = 90, organizationId?: string) {
    return signingService.listExpiring(days, organizationId);
  },
};

/**
 * Who hears about this company's certificate: the ACTIVE ADMINS of the
 * organization that owns it.
 *
 * The company→organization hop runs on `ownerDb` (a job has no tenant
 * context), and the membership lookup goes through the identity layer rather
 * than joining `users`/`organization_memberships` here — those three tables
 * sit outside RLS, and business-layer code reading them is the M-1 landmine.
 */
async function recipientsForCompany(companyId: string): Promise<string[]> {
  const [company] = await ownerDb
    .select({ organizationId: companiesTable.organizationId })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .limit(1);
  if (!company) return [];
  return membersRepository.activeAdminEmails(company.organizationId);
}

async function raiseReminder(reminder: RenewalReminder, now: Date): Promise<boolean> {
  const existing = await ownerDb
    .select({ id: zatcaCredentialRemindersTable.id })
    .from(zatcaCredentialRemindersTable)
    .where(
      and(
        eq(zatcaCredentialRemindersTable.credentialId, reminder.credentialId),
        eq(zatcaCredentialRemindersTable.thresholdDays, reminder.thresholdDays),
      ),
    )
    .limit(1);
  if (existing.length > 0) return false;

  // Best-effort delivery. The row is what makes the reminder visible; email is
  // the channel that gives it lead time, and we record which actually happened.
  //
  // 🔴 B1 found this addressed `zatca-admin+<companyId>@invalid.local` — a
  // placeholder that can never receive mail. Implementing a provider without
  // fixing it would have produced a working mailer that still reached nobody:
  // the same failure one layer down. Recipients are now the organization's
  // ACTIVE ADMINS, resolved through the identity layer (renewal needs an OTP
  // from their own Fatoora portal, which is an admin action).
  let delivered = false;
  try {
    const recipients = await recipientsForCompany(reminder.companyId);
    if (recipients.length === 0) {
      // Recorded, not swallowed: a company whose admins cannot be resolved is
      // a company that will not hear about its own expiry.
      logger.warn(
        { credentialId: reminder.credentialId, companyId: reminder.companyId },
        "renewal reminder: no active admin recipients — reminder is in-app only",
      );
    }
    const subject = `ZATCA certificate expires in ${reminder.daysRemaining} days`;
    const text =
      `The ZATCA signing certificate for this company expires on ` +
      `${reminder.notAfter.toISOString().slice(0, 10)} (${reminder.daysRemaining} days).\n\n` +
      `Renewal requires an OTP generated in YOUR Fatoora portal — it cannot be done for you. ` +
      `Once the certificate expires, invoices can no longer be cleared or reported.`;

    const results = await Promise.all(
      recipients.map((to) => mailer.send({ to, subject, text })),
    );
    // Delivered if it reached at least one admin — the alarm's purpose is that
    // a human learns in time, not that every admin did.
    delivered = results.some((r) => r.delivered);
  } catch (err) {
    logger.error({ err, credentialId: reminder.credentialId }, "renewal reminder: mail send failed");
  }

  try {
    await ownerDb.insert(zatcaCredentialRemindersTable).values({
      credentialId: reminder.credentialId,
      companyId: reminder.companyId,
      thresholdDays: reminder.thresholdDays,
      notAfter: reminder.notAfter,
      emailDelivered: String(delivered),
    });
  } catch (err) {
    // A concurrent instance won the unique index — that is the mechanism doing
    // its job, not a failure.
    logger.debug({ err, credentialId: reminder.credentialId }, "renewal reminder already recorded");
    return false;
  }

  logger.warn(
    {
      credentialId: reminder.credentialId,
      companyId: reminder.companyId,
      environment: reminder.environment,
      daysRemaining: reminder.daysRemaining,
      threshold: reminder.thresholdDays,
      emailDelivered: delivered,
    },
    "🔴 ZATCA certificate expiring — renewal needs the TENANT's own OTP",
  );
  return true;
}
