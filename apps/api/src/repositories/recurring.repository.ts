/**
 * Recurring rules and runs (A3) — split by connection, like the outbox.
 *
 *   `recurringRepository`     tenant transaction, RLS applies.
 *   `recurringJobRepository`  base pool, NO RLS — the generation job runs
 *                             outside any request and filters explicitly.
 */
import { db, pool, recurringRulesTable, recurringRunsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

export const recurringRepository = {
  async insertRule(values: typeof recurringRulesTable.$inferInsert) {
    const [row] = await db.insert(recurringRulesTable).values(values).returning();
    return row;
  },

  async findRule(id: string) {
    const [row] = await db.select().from(recurringRulesTable).where(eq(recurringRulesTable.id, id)).limit(1);
    return row ?? null;
  },

  listRules() {
    return db.select().from(recurringRulesTable).orderBy(recurringRulesTable.nextRunOn);
  },

  listRuns(ruleId: string, limit = 50) {
    return db
      .select()
      .from(recurringRunsTable)
      .where(eq(recurringRunsTable.ruleId, ruleId))
      .orderBy(desc(recurringRunsTable.ranAt))
      .limit(limit);
  },

  async setStatus(id: string, status: string) {
    const [row] = await db
      .update(recurringRulesTable)
      .set({ status })
      .where(eq(recurringRulesTable.id, id))
      .returning();
    return row ?? null;
  },

  async deleteRule(id: string) {
    await db.delete(recurringRulesTable).where(eq(recurringRulesTable.id, id));
  },
};

export interface DueRule {
  id: string;
  organizationId: string;
  companyId: string;
  entity: "invoice" | "bill";
  template: Record<string, unknown>;
  frequency: "monthly" | "quarterly" | "yearly";
  dayOfMonth: number;
  endsOn: string | null;
  nextRunOn: string;
  autoIssue: boolean;
  createdBy: number | null;
}

export const recurringJobRepository = {
  /**
   * Active rules due on or before `onDate`.
   *
   * 🔴 Dates are cast to TEXT in the query. The `pg` driver returns a `date`
   * column as a JS `Date`, whose `String()` is "Tue Sep 01 2026 …" — which then
   * fails as a date parameter on the way back in, which is exactly how it broke.
   * An occurrence is a CALENDAR DATE, not an instant, and keeping it a plain
   * YYYY-MM-DD string end to end avoids inventing a timezone for it.
   */
  async listDue(onDate: string, limit = 100, organizationId?: string): Promise<DueRule[]> {
    const { rows } = await pool.query(
      `SELECT id, organization_id AS "organizationId", company_id AS "companyId",
              entity, template, frequency, day_of_month AS "dayOfMonth",
              ends_on::text AS "endsOn", next_run_on::text AS "nextRunOn",
              auto_issue AS "autoIssue", created_by AS "createdBy"
         FROM recurring_rules
        WHERE status = 'active'
          AND next_run_on <= $1::date
          AND (ends_on IS NULL OR next_run_on <= ends_on)
          AND ($3::uuid IS NULL OR organization_id = $3::uuid)
        ORDER BY next_run_on
        LIMIT $2`,
      [onDate, limit, organizationId ?? null],
    );
    return rows as DueRule[];
  },

  /**
   * Record an attempt.
   *
   * `ON CONFLICT DO NOTHING` on `(rule_id, scheduled_for)` is the idempotency
   * guarantee: a job that runs twice, or two instances at once, cannot
   * double-generate. Returns null when the occurrence was already recorded —
   * which the caller treats as "someone else did it", not as an error.
   */
  async recordRun(v: {
    organizationId: string;
    ruleId: string;
    scheduledFor: string;
    outcome: "generated" | "issued" | "failed";
    documentId?: number | null;
    errorCode?: string | null;
    errorDetail?: string | null;
  }): Promise<{ id: string } | null> {
    const { rows } = await pool.query(
      `INSERT INTO recurring_runs
         (organization_id, rule_id, scheduled_for, outcome, document_id, error_code, error_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (rule_id, scheduled_for) DO NOTHING
       RETURNING id`,
      [
        v.organizationId,
        v.ruleId,
        v.scheduledFor,
        v.outcome,
        v.documentId ?? null,
        v.errorCode ?? null,
        v.errorDetail ?? null,
      ],
    );
    return rows[0] ?? null;
  },

  /**
   * Complete a claimed run.
   *
   * 🔴 An UPDATE, not a second insert. The claim row already occupies
   * `(rule_id, scheduled_for)`, so inserting again would hit the unique index
   * and silently do nothing — leaving every run stuck at `in_progress` while
   * documents were actually being generated. A run row is a state machine for
   * one occurrence, not an append-only log of attempts.
   *
   * The app role holds only SELECT + INSERT on this table (a tenant must not be
   * able to erase a failed run). The job runs on the OWNER connection, which is
   * the same owner/app-role split used everywhere else.
   */
  async finishRun(v: {
    ruleId: string;
    scheduledFor: string;
    outcome: "generated" | "issued" | "failed";
    documentId?: number | null;
    errorCode?: string | null;
    errorDetail?: string | null;
  }): Promise<void> {
    await pool.query(
      `UPDATE recurring_runs
          SET outcome = $3, document_id = $4, error_code = $5, error_detail = $6, ran_at = now()
        WHERE rule_id = $1 AND scheduled_for = $2::date`,
      [v.ruleId, v.scheduledFor, v.outcome, v.documentId ?? null, v.errorCode ?? null, v.errorDetail ?? null],
    );
  },

  /**
   * Move a rule to its next occurrence.
   *
   * 🔴 Called after BOTH success and failure, and that is deliberate. A failed
   * occurrence is already recorded in `recurring_runs`, so it is visible; NOT
   * advancing would make the job retry the same locked period every day,
   * producing one identical failure per day and burying the signal it exists to
   * send. The missed occurrence is a record, not a queue item.
   */
  async advance(ruleId: string, nextRunOn: string): Promise<void> {
    await pool.query(`UPDATE recurring_rules SET next_run_on = $2::date WHERE id = $1`, [ruleId, nextRunOn]);
  },

  /** Rules whose most recent run failed — the surface for the rules list. */
  async listWithFailures(limit = 100, organizationId?: string) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (r.rule_id)
              r.rule_id AS "ruleId", r.scheduled_for AS "scheduledFor",
              r.outcome, r.error_code AS "errorCode", r.error_detail AS "errorDetail"
         FROM recurring_runs r
         JOIN recurring_rules ru ON ru.id = r.rule_id
        WHERE ($2::uuid IS NULL OR r.organization_id = $2::uuid)
        ORDER BY r.rule_id, r.ran_at DESC
        LIMIT $1`,
      [limit, organizationId ?? null],
    );
    return rows.filter((r: { outcome: string }) => r.outcome === "failed");
  },
};

export { and };
