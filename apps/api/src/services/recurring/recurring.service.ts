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

export type Frequency = "monthly" | "quarterly" | "yearly";
const FREQUENCIES: Frequency[] = ["monthly", "quarterly", "yearly"];

export interface CreateRuleInput {
  entity: "invoice" | "bill";
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
export async function mayAutoIssue(role: string | null, entity: "invoice" | "bill"): Promise<boolean> {
  if (!role) return false;
  return can(role, entity === "invoice" ? "invoices" : "bills", "approve");
}

export const recurringService = {
  async create(input: CreateRuleInput, ctx: { userId: number | null; role: string | null }) {
    if (!["invoice", "bill"].includes(input.entity)) {
      throw new BadRequestError("entity must be 'invoice' or 'bill'");
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

  list: () => recurringRepository.listRules(),

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
