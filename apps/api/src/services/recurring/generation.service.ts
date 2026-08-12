/**
 * Recurring generation (A3) — the job that turns rules into drafts.
 *
 * ── 🔴 IT USES THE SAME CREATE PATH A HUMAN USES ───────────────────────────
 * Generation calls `invoicesService.create` / `billsService.create`, not a
 * parallel writer. So validation, tax-category resolution (M13), seller identity
 * (M11.6), the note guards (M12.1b) and the period lock all behave identically
 * to a hand-entered document. A second creation path would be a second place for
 * every one of those rules to be got wrong, drifting silently — the same
 * argument that made the TLV codec a shared package rather than a copy.
 *
 * ── 🔴 A LOCKED PERIOD FAILS LOUDLY. IT DOES NOT SKIP. ─────────────────────
 * A skipped recurring invoice means **a customer was not billed and nothing says
 * so.** That is worse than the ZATCA outbox case: an unsubmitted invoice
 * eventually draws a complaint from ZATCA, whereas an unsent one has no external
 * party who will ever notice — and the only person who could catch it is the one
 * who automated it precisely so they would stop watching.
 *
 * Re-dating into the next open period was also rejected: it moves revenue
 * between VAT periods, which is a tax decision a job must not take quietly.
 */
import { beginTenantConnection } from "@workspace/db";
import { logger } from "../../lib/logger";
import { auditContext } from "../../lib/auditContext";
import { invoicesService } from "../invoices.service";
import { billsService } from "../bills.service";
import { recurringJobRepository, type DueRule } from "../../repositories/recurring.repository";
import { nextOccurrence } from "./recurring.service";

export interface GenerationResult {
  due: number;
  generated: number;
  failed: number;
  alreadyRun: number;
}

/** Today, UTC, as YYYY-MM-DD. */
const today = (): string => new Date().toISOString().slice(0, 10);

export const recurringGenerationService = {
  async runOnce(onDate: string = today(), organizationId?: string): Promise<GenerationResult> {
    const due = await recurringJobRepository.listDue(onDate, 100, organizationId);
    const result: GenerationResult = { due: due.length, generated: 0, failed: 0, alreadyRun: 0 };

    for (const rule of due) {
      const outcome = await generateOne(rule);
      if (outcome === "generated") result.generated += 1;
      else if (outcome === "already") result.alreadyRun += 1;
      else result.failed += 1;
    }

    if (result.generated > 0 || result.failed > 0) {
      logger.info(result, "recurring document generation pass complete");
    }
    return result;
  },
};

async function generateOne(rule: DueRule): Promise<"generated" | "failed" | "already"> {
  const scheduledFor = rule.nextRunOn;

  // Claim the occurrence BEFORE doing the work. `recordRun` is unique on
  // (rule_id, scheduled_for), so a concurrent instance that lost the race gets
  // null and stops — no double generation, and no reliance on the job being
  // single-instance.
  const claim = await recurringJobRepository.recordRun({
    organizationId: rule.organizationId,
    ruleId: rule.id,
    scheduledFor,
    outcome: "failed",
    errorCode: "in_progress",
    errorDetail: "Generation started.",
  });
  if (!claim) return "already";

  const advance = () =>
    recurringJobRepository.advance(rule.id, nextOccurrence(scheduledFor, rule.frequency, rule.dayOfMonth));

  const conn = await beginTenantConnection({
    organizationId: rule.organizationId,
    companyId: rule.companyId,
    role: "authenticated",
  });

  try {
    const document = await conn.run(() =>
      auditContext.run(
        { userId: rule.createdBy, organizationId: rule.organizationId, ipAddress: null },
        async () => {
          const body = { ...(rule.template as Record<string, unknown>), date: scheduledFor };
          // 🔴 DRAFTS ONLY. `autoApprove: false` is not a default being relied
          // on — it is stated, because approval here would issue a legal
          // document unattended: an ICV consumed, a ZATCA chain position taken,
          // correction only by credit note. See the A3 spec §2.
          return rule.entity === "invoice"
            ? invoicesService.create(body, rule.createdBy, { autoApprove: false })
            : billsService.create(body, rule.createdBy);
        },
      ),
    );
    await conn.commit();

    await recurringJobRepository.finishRun({
      ruleId: rule.id,
      scheduledFor,
      outcome: "generated",
      documentId: (document as { id: number }).id,
    });
    await advance();
    return "generated";
  } catch (err) {
    await conn.rollback();

    // A locked period is the expected failure and deserves its own code, so the
    // UI can say what to do rather than showing a stack trace.
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const errorCode = statusCode === 423 ? "period_locked" : "generation_failed";
    const errorDetail =
      err instanceof Error ? err.message.slice(0, 500) : "The document could not be generated.";

    await recurringJobRepository.finishRun({
      ruleId: rule.id,
      scheduledFor,
      outcome: "failed",
      errorCode,
      errorDetail,
    });

    // 🔴 Advance anyway. The failure is recorded and visible; NOT advancing
    // would retry the same locked period every single day, producing one
    // identical failure per day and burying the signal this exists to send. The
    // missed occurrence is a record, not a queue item.
    await advance();

    logger.warn(
      { ruleId: rule.id, scheduledFor, errorCode },
      "recurring document could not be generated — recorded as a failed run",
    );
    return "failed";
  }
}
