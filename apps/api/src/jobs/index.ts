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

export const JOB_OUTBOX = "einvoice-outbox";
export const JOB_ARCHIVE = "einvoice-archive";
export const JOB_RENEWAL = "zatca-renewal-reminders";

let scheduler: JobScheduler | null = null;

export function buildScheduler(): JobScheduler {
  const env = loadEnv();
  const s = new JobScheduler();

  // Routed through the EInvoiceProvider seam (S1) rather than around it, so
  // submission — most of what a certified vendor actually sells — is genuinely
  // swappable per company. The provider resolves its own transport credentials
  // from the vault, exactly as a vendor would hold its own.
  const worker = new EInvoiceWorker({ provider: resolveProvider() });

  const jobs: Job[] = [
    {
      name: JOB_OUTBOX,
      intervalMs: env.ZATCA_WORKER_INTERVAL_MS,
      runOnce: () => worker.runOnce(),
    },
    {
      // Slower than the outbox: archival is not time-critical the way ZATCA's
      // 24-hour reporting deadline is, and it re-reads every accepted document
      // that lacks an archive row.
      name: JOB_ARCHIVE,
      intervalMs: 5 * 60_000,
      runOnce: () => archiveService.runOnce(),
    },
    {
      // Certificate expiry moves in days, so hourly is generous. It runs at all
      // because a T-90 reminder is only useful if it fires near T-90.
      name: JOB_RENEWAL,
      intervalMs: 60 * 60_000,
      runOnce: () => renewalService.runOnce(),
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
 * Start background work if configured to.
 *
 * 🔴 Default OFF. The outbox worker transmits to a government API, so running
 * it is a deliberate act — and until a tenant has actually onboarded, there is
 * nothing for it to send. With the flag off the jobs still exist and the
 * operator can run any of them on demand.
 */
export function startBackgroundJobs(): void {
  const env = loadEnv();
  if (!env.ZATCA_WORKER_ENABLED) {
    logger.info("background jobs are disabled (ZATCA_WORKER_ENABLED=false); run them on demand from /operator");
    return;
  }
  getScheduler().start();
}
