import { pgTable, text, timestamp, integer, uuid, boolean, date, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

/**
 * Recurring document rules (A3) — rent, retainers, subscriptions.
 *
 * ── 🔴 A RULE GENERATES A DRAFT. IT NEVER ISSUES. ──────────────────────────
 * `auto_issue` exists and is **always false in v1**. The column and its guard
 * are built now so that when auto-issue does ship the authority check already
 * exists rather than having to be remembered.
 *
 * Why drafts: approval fires issuance — an ICV consumed, a position taken in the
 * ZATCA hash chain, a QR minted, AR posted, a submission queued. None of it
 * reversible; correction needs a credit note, a second legal document in the
 * same chain.
 *
 * M10.4's self-approve-on-create does not extend here, and the reason is the
 * point: **self-approve works because the approver is looking at the specific
 * document.** Creating an invoice is an act about *that invoice*. Creating a rule
 * is an act about a **pattern**, and patterns drift — the customer cancels, the
 * price changes, the author leaves. Consent to a pattern in January is not
 * consent to what it produces in November.
 */
export const recurringRulesTable = pgTable(
  "recurring_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),

    /** `invoice` | `bill`. Sales side and purchase side use the same engine. */
    entity: text("entity").notNull(),
    /**
     * The document to generate, in the same shape the create endpoint accepts.
     *
     * Stored rather than referenced so editing the original invoice does not
     * silently change every future generation — a rule is a decision taken once,
     * not a live mirror of another row.
     */
    template: jsonb("template").notNull(),

    frequency: text("frequency").notNull(), // monthly | quarterly | yearly
    /** 1–31; clamped to the month's last day, so the 31st works in February. */
    dayOfMonth: integer("day_of_month").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    /** The next date this rule is due. Advanced only on a SUCCESSFUL run. */
    nextRunOn: date("next_run_on").notNull(),

    /**
     * 🔴 ALWAYS FALSE IN V1. When it ships, it may only be set by a user who
     * holds `approve` on the entity — a rule must never grant authority its
     * creator does not hold (the M11.7 invitation invariant) — and that
     * authority is **re-checked at generation, never stored**. A rule is not a
     * credential: if the creator's role is reduced or their membership
     * deactivated, generation falls back to drafts.
     */
    autoIssue: boolean("auto_issue").notNull().default(false),

    status: text("status").notNull().default("active"), // active | paused
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("recurring_rules_due_idx").on(table.status, table.nextRunOn),
    index("recurring_rules_org_idx").on(table.organizationId, table.companyId),
  ],
);

/**
 * One row per generation attempt — the answer to "did my rent invoice go out?".
 *
 * 🔴 THIS TABLE IS WHY A LOCKED PERIOD FAILS LOUDLY RATHER THAN SKIPPING.
 * A skipped recurring invoice means a customer was not billed and nothing says
 * so — quiet neglect, and worse than the ZATCA outbox case, because an
 * unsubmitted invoice eventually draws a complaint from ZATCA whereas an unsent
 * one has no external party who will ever notice. A failed run is a visible
 * record with a reason.
 *
 * `unique(rule_id, scheduled_for)` is the idempotency guarantee: a job that runs
 * twice, or two instances running concurrently, cannot double-generate. Same
 * mechanism as the archive sweep and the renewal reminders.
 */
export const recurringRunsTable = pgTable(
  "recurring_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => recurringRulesTable.id, { onDelete: "cascade" }),

    /** The occurrence this run is for — not when it ran. */
    scheduledFor: date("scheduled_for").notNull(),
    /** `generated` (a draft exists) | `failed`. `issued` is reserved for auto-issue. */
    outcome: text("outcome").notNull(),
    /** The invoice/bill id when generated. */
    documentId: integer("document_id"),
    /** e.g. `period_locked`, `validation_failed`. Machine-readable on purpose. */
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("recurring_runs_rule_occurrence_unq").on(table.ruleId, table.scheduledFor),
    index("recurring_runs_rule_idx").on(table.ruleId, table.ranAt),
  ],
);

export type RecurringRule = typeof recurringRulesTable.$inferSelect;
export type RecurringRun = typeof recurringRunsTable.$inferSelect;
