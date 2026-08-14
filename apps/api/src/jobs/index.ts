/**
 * The platform's background jobs (M12.8).
 *
 * One scheduler, three jobs. Each is independently runnable via
 * `scheduler.runNow(name)`, which is what makes them useful — and testable —
 * with `ZATCA_WORKER_ENABLED` off.
 */
import { loadEnv } from "@workspace/config";
import { logger } from "../lib/logger";
import { JobScheduler, type Job } from "./scheduler";
import { EInvoiceWorker } from "../services/einvoice/outbox/worker";
import { resolveProvider } from "../services/einvoice/zatca/zatcaDirectProvider";
import { archiveService } from "../services/einvoice/archive/archive.service";
import { renewalService } from "../services/einvoice/renewal/renewal.service";
import { capturePromotionService } from "../services/capture/promotion.service";
import { recurringGenerationService } from "../services/recurring/generation.service";
import { alarmsService } from "../services/alerting/alarms.service";

export const JOB_OUTBOX = "einvoice-outbox";
export const JOB_ARCHIVE = "einvoice-archive";
export const JOB_RENEWAL = "zatca-renewal-reminders";
export const JOB_CAPTURE_PROMOTION = "capture-promotion";
export const JOB_CAPTURE_PURGE = "capture-purge";
export const JOB_RECURRING = "recurring-documents";
export const JOB_ALARMS = "platform-alarms";

let scheduler: JobScheduler | null = null;

export function buildScheduler(): JobScheduler {
  const env = loadEnv();
  const s = new JobScheduler();

  // Routed through the EInvoiceProvider seam (S1) rather than around it, so
  // submission — most of what a certified vendor actually sells — is genuinely
  // swappable per company. The provider resolves its own transport credentials
  // from the vault, exactly as a vendor would hold its own.
  const worker = new EInvoiceWorker({ provider: resolveProvider() });

  // ── Audit Tier 3 (scope-drift fix): ZATCA transmission is the ONLY thing
  // `ZATCA_WORKER_ENABLED` gates now. It used to gate the entire scheduler —
  // so a flag named for a government-API worker silently disabled recurring
  // generation, capture promotion/purge and renewal reminders, none of which
  // transmit anything. Platform jobs run whenever the process runs; the two
  // transport jobs are registered (operator run-now still works) but stay off
  // the timers until the flag is on.
  const zatcaTransportScheduled = env.ZATCA_WORKER_ENABLED;

  const jobs: Job[] = [
    {
      name: JOB_OUTBOX,
      intervalMs: env.ZATCA_WORKER_INTERVAL_MS,
      runOnce: () => worker.runOnce(),
      scheduled: zatcaTransportScheduled,
    },
    {
      // Slower than the outbox: archival is not time-critical the way ZATCA's
      // 24-hour reporting deadline is, and it re-reads every accepted document
      // that lacks an archive row.
      name: JOB_ARCHIVE,
      intervalMs: 5 * 60_000,
      runOnce: () => archiveService.runOnce(),
      scheduled: zatcaTransportScheduled,
    },
    {
      // Certificate expiry moves in days, so hourly is generous. It runs at all
      // because a T-90 reminder is only useful if it fires near T-90.
      name: JOB_RENEWAL,
      intervalMs: 60 * 60_000,
      runOnce: () => renewalService.runOnce(),
    },
    {
      // A1: moves a posted capture's bytes from staging into the immutable
      // archive. Frequent, because until it runs a bill's evidence exists only
      // in deletable storage — a visible gap, but a gap.
      name: JOB_CAPTURE_PROMOTION,
      intervalMs: 60_000,
      runOnce: () => capturePromotionService.runOnce(),
    },
    {
      // A3: turns due recurring rules into DRAFTS. Daily — occurrences are
      // dated, not timed, so running more often would only re-check the same
      // dates. Each occurrence is claimed by a unique index, so a second
      // instance cannot double-generate.
      name: JOB_RECURRING,
      intervalMs: 24 * 60 * 60_000,
      runOnce: () => recurringGenerationService.runOnce(),
    },
    {
      // A1: removes abandoned captures. Never touches anything posted to a
      // bill. Daily is ample — it exists so stray photographs do not accumulate
      // indefinitely, which is a cost and a PDPL question (queue C8), not an
      // urgent one.
      name: JOB_CAPTURE_PURGE,
      intervalMs: 24 * 60 * 60_000,
      runOnce: () => capturePromotionService.purgeOnce(),
    },
    {
      // B2: evaluates the platform alarms. A PLATFORM job — it transmits
      // nothing to ZATCA, it watches whether we are failing to. Every 5
      // minutes, because both conditions it detects race real deadlines (a
      // 24-hour reporting window; a certificate expiry) and because a
      // firing condition re-pages on its own cooldown, not on this interval.
      name: JOB_ALARMS,
      intervalMs: 5 * 60_000,
      runOnce: () => alarmsService.runOnce(),
    },
  ];

  for (const job of jobs) s.register(job);
  return s;
}

/** The process-wide scheduler, built on first use. */
export function getScheduler(): JobScheduler {
  if (!scheduler) scheduler = buildScheduler();
  return scheduler;
}

/**
 * Start background work.
 *
 * PLATFORM jobs (recurring generation, capture promotion/purge, renewal
 * reminders) always run — a rent invoice must generate whether or not ZATCA
 * transmission is configured. 🔴 The two ZATCA TRANSPORT jobs (outbox,
 * archive) stay off the timers unless `ZATCA_WORKER_ENABLED` — transmitting
 * to a government API is a deliberate act, and until a tenant has onboarded
 * there is nothing to send. Every job remains operator-runnable on demand.
 */
export function startBackgroundJobs(): void {
  const env = loadEnv();
  if (!env.ZATCA_WORKER_ENABLED) {
    logger.info("ZATCA transport jobs are unscheduled (ZATCA_WORKER_ENABLED=false); platform jobs run normally");
  }
  getScheduler().start();
}
