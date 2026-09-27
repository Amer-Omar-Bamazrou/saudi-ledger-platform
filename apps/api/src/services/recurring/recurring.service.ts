/**
 * Recurring documents (A3) — rules, generation, and run history.
 *
 * The sales-side half of the wedge: A1 removed typing on purchases, this removes
 * it on rent, retainers and subscriptions.
 */
import { BadRequestError, NotFoundError } from "../../lib/errors";
import { can } from "../../lib/rbac";
import { auditService } from "../audit.service";
import { recurringRepository } from "../../repositories/recurring.repository";
import { round2 } from "../../lib/money";

export type Frequency = "monthly" | "quarterly" | "yearly";
const FREQUENCIES: Frequency[] = ["monthly", "quarterly", "yearly"];

export interface CreateRuleInput {
  entity: "invoice" | "bill" | "journal_entry";
  template: Record<string, unknown>;
  frequency: Frequency;
  dayOfMonth: number;
  startsOn: string;
  endsOn?: string | null;
  autoIssue?: boolean;
}

/**
 * Advance a date by one period, clamping to the month's last day.
 *
 * 🔴 The 31st is not a rare edge — it is the most common "end of month" choice a
 * user makes, and it does not exist in February, April, June, September or
 * November. Naive date arithmetic silently rolls the 31st of February into
 * 3 March, so a monthly rule set for month-end drifts forward through the year.
 * `dayOfMonth` is therefore the INTENT, and the actual date is derived from it
 * each period rather than incremented.
 */
export function nextOccurrence(from: string, frequency: Frequency, dayOfMonth: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  const monthsToAdd = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12;

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + monthsToAdd;
  // Day 0 of the following month is the last day of the target month.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(dayOfMonth, lastDay);

  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/**
 * 🔴 THE AUTHORITY INVARIANT — built now, unused in v1.
 *
 * `autoIssue` is always false today, so nothing calls this in anger. It exists
 * because when auto-issue ships, the check must ALREADY be here rather than be
 * remembered: a rule that issues invoices is a standing grant of authority, and
 * the M11.7 invitation invariant applies exactly — **no rule may grant more than
 * its creator holds.**
 *
 * Two properties, both deliberate:
 *   1. checked against the entity's `approve` action, not `create` — issuing is
 *      approval-level authority, which is why M10.1 separated the two;
 *   2. **re-checked at GENERATION, never stored.** A rule is not a credential.
 *      If the author's role is reduced or their membership deactivated, the rule
 *      falls back to drafts instead of continuing to act with authority its
 *      owner no longer has.
 */
export async function mayAutoIssue(role: string | null, entity: "invoice" | "bill" | "journal_entry"): Promise<boolean> {
  if (!role) return false;
  // A recurring JOURNAL ENTRY would be POSTED, not issued, and posting is the
  // approver's act on the entry itself — the same authority `approve` names.
  return can(role, entity === "invoice" ? "invoices" : entity === "bill" ? "bills" : "journal-entries", "approve");
}

export const recurringService = {
  async create(input: CreateRuleInput, ctx: { userId: number | null; role: string | null }) {
    if (!["invoice", "bill", "journal_entry"].includes(input.entity)) {
      throw new BadRequestError("entity must be 'invoice', 'bill' or 'journal_entry'");
    }
    /**
     * 🔴 A1 (2026-09-22) — A RECURRING JOURNAL ENTRY'S TEMPLATE IS CHECKED
     * HERE, not only when it runs.
     *
     * A rule is a decision taken once and executed unattended for months. An
     * invoice template that is wrong produces a draft somebody reads; a
     * journal-entry template that is wrong produces a FAILED RUN every period
     * until someone notices, and the thing they have to notice is a row in a
     * run log. The cheapest moment to refuse is while the author is still
     * looking at what they wrote.
     *
     * Only the shape is checked — that it has at least two lines and that they
     * balance. Account existence, the party on a control line and the period
     * are the posting path's business and are re-checked at every generation,
     * because they can change between now and November.
     */
    if (input.entity === "journal_entry") {
      const lines = (input.template as { lines?: unknown })?.lines;
      if (!Array.isArray(lines) || lines.length < 2) {
        throw new BadRequestError("A recurring journal entry needs a template with at least two lines.");
      }
      let debits = 0, credits = 0;
      for (const l of lines as Array<{ debitAmount?: unknown; creditAmount?: unknown }>) {
        debits += Number(l.debitAmount ?? 0);
        credits += Number(l.creditAmount ?? 0);
      }
      if (Math.abs(round2(debits) - round2(credits)) > 0.005) {
        throw new BadRequestError(
          `A recurring journal entry's template must balance: the lines total ${round2(debits).toFixed(2)} in debits and ${round2(credits).toFixed(2)} in credits.`,
        );
      }
      if (round2(debits) === 0) {
        throw new BadRequestError("A recurring journal entry's template must move a non-zero amount.");
      }
    }
    if (!FREQUENCIES.includes(input.frequency)) {
      throw new BadRequestError(`frequency must be one of: ${FREQUENCIES.join(", ")}`);
    }
    if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
      throw new BadRequestError("dayOfMonth must be between 1 and 31");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn)) {
      throw new BadRequestError("startsOn must be a date (YYYY-MM-DD)");
    }
    if (input.endsOn && input.endsOn < input.startsOn) {
      throw new BadRequestError("endsOn cannot be before startsOn");
    }

    // 🔴 v1 ships DRAFTS ONLY. Refused rather than silently ignored: a caller
    // who asked for auto-issue and got drafts without being told would believe
    // their invoices are going out.
    if (input.autoIssue) {
      throw new BadRequestError(
        "Automatic issuing is not available yet. A recurring rule creates a draft for approval — " +
          "issuing an invoice consumes a ZATCA sequence number and cannot be undone, so it is not " +
          "done unattended.",
      );
    }

    const rule = await recurringRepository.insertRule({
      entity: input.entity,
      template: input.template,
      frequency: input.frequency,
      dayOfMonth: input.dayOfMonth,
      startsOn: input.startsOn,
      endsOn: input.endsOn ?? null,
      // The first occurrence is the start date itself, clamped.
      nextRunOn: clampToMonth(input.startsOn, input.dayOfMonth),
      autoIssue: false,
      status: "active",
      createdBy: ctx.userId,
    });

    await auditService.created("recurring_rule", rule.id, {
      entity: rule.entity,
      frequency: rule.frequency,
      nextRunOn: rule.nextRunOn,
    });
    return rule;
  },

  /**
   * Rules with their health.
   *
   * The list answers "did my invoices go out?", so it carries the last outcome
   * AND the consecutive-failure streak — one failure and three in a row are
   * different problems and must not render the same.
   */
  async list() {
    const [rules, health] = await Promise.all([
      recurringRepository.listRules(),
      recurringRepository.health(),
    ]);
    const byRule = new Map(health.map((h) => [h.rule_id, h]));
    return rules.map((r) => {
      const h = byRule.get(r.id);
      return {
        ...r,
        lastOutcome: h?.last_outcome ?? null,
        lastScheduledFor: h?.last_scheduled_for ?? null,
        lastErrorCode: h?.last_error_code ?? null,
        lastErrorDetail: h?.last_error_detail ?? null,
        consecutiveFailures: h?.consecutive_failures ?? 0,
        lastSuccessOn: h?.last_success_on ?? null,
      };
    });
  },

  async runs(ruleId: string) {
    const rule = await recurringRepository.findRule(ruleId);
    if (!rule) throw new NotFoundError("Recurring rule not found");
    return recurringRepository.listRuns(ruleId);
  },

  async pause(ruleId: string, paused: boolean) {
    const before = await recurringRepository.findRule(ruleId);
    if (!before) throw new NotFoundError("Recurring rule not found");
    const rule = await recurringRepository.setStatus(ruleId, paused ? "paused" : "active");
    if (!rule) throw new NotFoundError("Recurring rule not found");
    // Pausing a rule silently stops a customer being billed, so it is audited
    // with both sides — "who turned this off, and when" is a real question.
    await auditService.updated("recurring_rule", ruleId, { status: before.status }, { status: rule.status });
    return rule;
  },

  async remove(ruleId: string) {
    const rule = await recurringRepository.findRule(ruleId);
    if (!rule) throw new NotFoundError("Recurring rule not found");
    await recurringRepository.deleteRule(ruleId);
    // The run history cascades — it belongs to the rule. The generated
    // DOCUMENTS do not: those are real invoices and bills and are untouched.
    await auditService.deleted("recurring_rule", ruleId, { entity: rule.entity });
  },
};

/** The start date, clamped so a 31st start in a 30-day month is the 30th. */
function clampToMonth(isoDate: string, dayOfMonth: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(dayOfMonth, lastDay)))
    .toISOString()
    .slice(0, 10);
}
