/**
 * The platform's background-job scheduler (M12.8).
 *
 * ── This is the FIRST background-job infrastructure in the repository ───────
 * Before M12.8 the API had exactly one entrypoint and no scheduler of any kind.
 * `EInvoiceWorker` shipped its own `while` loop in M12.6 and was never started.
 * Rather than let each new periodic task invent its own timer, the loop lives
 * here once and jobs supply only a `runOnce`.
 *
 * ── The idiom, inherited from EInvoiceWorker and worth keeping ──────────────
 *  1. **`runOnce()` is separate from the loop.** Tests drive a single pass
 *     deterministically instead of racing a timer, and the operator surface can
 *     trigger a job on demand. Every job here is useful with the scheduler off.
 *  2. **A job never dies on one bad pass.** An exception is logged and the next
 *     tick still runs; one poisoned document must not stop the queue draining.
 *  3. **Jobs are staggered** so three timers do not fire in the same tick and
 *     contend for the pool.
 *
 * ── What this deliberately is NOT ──────────────────────────────────────────
 * In-process and single-instance. Two API instances with `ZATCA_WORKER_ENABLED`
 * both run every job — safe for the outbox (claiming is `FOR UPDATE SKIP
 * LOCKED`) and for the archive (a unique index makes a double archive a no-op),
 * but the renewal check would send duplicate reminders, which is why its
 * idempotency is a DB constraint rather than a scheduling assumption. Moving to
 * a real queue is a scaling decision, not a correctness one.
 */
import { logger } from "../lib/logger";

export interface Job {
  /** Stable identifier — used for logs and the operator's run-now endpoint. */
  readonly name: string;
  readonly intervalMs: number;
  /** One pass. Must be safe to call concurrently with its own scheduled tick. */
  runOnce(): Promise<unknown>;
  /**
   * When false, the job is registered (so `runNow` and the operator surface
   * still reach it) but `start()` never puts it on a timer. Audit Tier 3: this
   * is how ZATCA transmission stays a deliberate act (`ZATCA_WORKER_ENABLED`)
   * without that flag silently disabling every NON-ZATCA platform job — which
   * is exactly what happened to recurring generation and capture purge when
   * the whole scheduler was gated on it (a flag's scope drifting past its
   * name). Default: scheduled.
   */
  readonly scheduled?: boolean;
}

export class JobScheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly timers: NodeJS.Timeout[] = [];
  private running = false;

  register(job: Job): this {
    if (this.jobs.has(job.name)) throw new Error(`Duplicate job name: ${job.name}`);
    this.jobs.set(job.name, job);
    return this;
  }

  /** Job names, for the operator surface. */
  names(): string[] {
    return [...this.jobs.keys()];
  }

  /** Names `start()` will actually put on timers (audit Tier 3 flag split). */
  scheduledNames(): string[] {
    return [...this.jobs.values()].filter((j) => j.scheduled !== false).map((j) => j.name);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    let stagger = 0;
    for (const job of this.jobs.values()) {
      if (job.scheduled === false) continue; // reachable via runNow only
      const delay = stagger;
      stagger += 2_000;

      const tick = async () => {
        if (!this.running) return;
        try {
          await job.runOnce();
        } catch (err) {
          // Never let one failed pass kill the schedule.
          logger.error({ err, job: job.name }, "scheduled job failed");
        }
      };

      // `setInterval` would queue overlapping runs if a pass outlived its
      // interval — a slow ZATCA response must not stack up submissions. Each
      // tick schedules the next one only after it finishes.
      const loop = async () => {
        await tick();
        if (!this.running) return;
        const t = setTimeout(loop, job.intervalMs);
        t.unref?.();
        this.timers.push(t);
      };

      const first = setTimeout(loop, delay);
      first.unref?.();
      this.timers.push(first);
    }

    logger.info(
      { scheduled: [...this.jobs.values()].filter((j) => j.scheduled !== false).map((j) => j.name),
        onDemandOnly: [...this.jobs.values()].filter((j) => j.scheduled === false).map((j) => j.name) },
      "background job scheduler started",
    );
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.length = 0;
    logger.info("background job scheduler stopped");
  }

  /**
   * Run one job immediately, outside its schedule.
   *
   * This is what makes every job usable with `ZATCA_WORKER_ENABLED` off — the
   * operator can drain the outbox, sweep the archive or re-check certificate
   * expiry on demand, and tests need no timer at all.
   */
  async runNow(name: string): Promise<unknown> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown job: ${name}`);
    logger.info({ job: name }, "running job on demand");
    return job.runOnce();
  }
}
