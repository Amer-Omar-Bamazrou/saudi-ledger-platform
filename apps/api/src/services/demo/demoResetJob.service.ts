/**
 * The scheduling half of the weekly demo reset (D6/D9).
 *
 * Split from `demoReset.service` so the destructive act and the decision to
 * perform it are separately testable — a test can prove "is it due?" without
 * truncating anything.
 *
 * 🔴 DUE-NESS IS DERIVED FROM THE LAST SUCCESSFUL RUN, not from a timer. An
 * in-process interval restarts with the process, so a demo that redeploys twice
 * a week would never reset, while the banner kept promising it did. Reading the
 * recorded runs makes the schedule survive restarts and makes a failed run
 * count as "still due" rather than "done".
 */
import { loadEnv } from "@workspace/config";
import { logger } from "../../lib/logger";
import { lastSuccessfulReset, runDemoReset, type DemoResetOutcome } from "./demoReset.service";
import { nextResetAt } from "./demoSchedule";

export interface DemoResetJobResult {
  ran: boolean;
  reason: string;
  outcome?: DemoResetOutcome;
}

export const demoResetJob = {
  /**
   * Evaluate and, if due, reset. Never throws — `runDemoReset` records its own
   * failure, and a scheduler job that dies takes its own next run with it.
   */
  async runOnce(now: Date = new Date()): Promise<DemoResetJobResult> {
    const env = loadEnv();
    if (!env.DEMO_MODE) return { ran: false, reason: "DEMO_MODE is off" };

    try {
      const last = await lastSuccessfulReset();
      const due = nextResetAt(last, env.DEMO_RESET_INTERVAL_DAYS, now);
      if (now < due) {
        return { ran: false, reason: `next reset due ${due.toISOString()}` };
      }
      const outcome = await runDemoReset();
      return { ran: true, reason: outcome.detail, outcome };
    } catch (err) {
      logger.error({ err }, "[demo-reset] scheduling check failed");
      return { ran: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
};
