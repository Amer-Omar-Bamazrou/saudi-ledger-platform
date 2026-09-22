/**
 * PHASE 11 A1 — RECURRING JOURNAL ENTRIES (2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §2.
 *
 * 🔴 The engine was NOT rebuilt. `recurring_rules` / `recurring_runs` already
 * carried everything A1 asks for and had been proven on invoices and bills:
 * frequency, the day clamped to a short month, start/end, `next_run_on`
 * advanced only on success, `unique(rule_id, scheduled_for)` as the
 * duplicate-generation guarantee, and a LOUD `period_locked` failure instead of
 * a silent skip. A1 is a third entity on a proven engine, and the tests below
 * are about the two things that are genuinely new:
 *
 *   · a journal-entry template is checked for BALANCE when the rule is
 *     written, because a rule is executed unattended for months and a bad one
 *     otherwise fails silently into a run log every period;
 *   · the generated entry is a DRAFT that moves nothing, and a run into a
 *     CLOSED month fails loudly and records why.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { recurringService } from "../services/recurring/recurring.service";
import { recurringGenerationService } from "../services/recurring/generation.service";
import { periodLocksService } from "../services/periodLocks.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Phase 11 A1 — recurring journal entries (real rows)", () => {
  const SLUG = "p11-a1";
  const EMAIL = "p11-a1@test.local";
  let orgId = "", companyId = "", userId = 0, expenseId = 0, accrualId = 0;

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      await client.query(`DELETE FROM recurring_runs WHERE organization_id IN ${org}`);
      await client.query(`DELETE FROM recurring_rules WHERE organization_id IN ${org}`);
      for (const t of ["journal_entry_lines", "journal_entries", "period_locks", "findings", "finding_runs", "audit_logs", "organization_memberships", "bank_accounts", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const accountId = async (code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
  const ctx = () => ({ userId, role: "admin" });
  const template = (amount: number) => ({
    description: "Monthly office rent accrual",
    lines: [
      { accountId: expenseId, accountName: "Rent", debitAmount: amount, creditAmount: 0, description: "Rent" },
      { accountId: accrualId, accountName: "Accrued", debitAmount: 0, creditAmount: amount, description: "Accrued" },
    ],
  });
  /** Force a rule to be due on a chosen date, the way the clock would. */
  const makeDue = (ruleId: string, on: string) =>
    pool.query(`UPDATE recurring_rules SET next_run_on = $2 WHERE id = $1`, [ruleId, on]);

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P11 A1','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P11 A1 Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P11',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    expenseId = await accountId("PURCHASES");
    accrualId = await accountId("RETAINED_EARNINGS");
  }, 60_000);
  afterAll(cleanup);

  it("🔴 an UNBALANCED template is refused when the rule is WRITTEN — not months later, one failed run at a time", async () => {
    const bad = {
      entity: "journal_entry" as const, frequency: "monthly", dayOfMonth: 1,
      startsOn: "2026-06-01",
      template: { description: "Wrong", lines: [
        { accountId: expenseId, accountName: "a", debitAmount: 100, creditAmount: 0, description: "d" },
        { accountId: accrualId, accountName: "b", debitAmount: 0, creditAmount: 90, description: "c" },
      ] },
    };
    await expect(inTenant(() => recurringService.create(bad as never, ctx()))).rejects.toThrow(/must balance/);
    // …and the message NAMES both totals, so the author can see which side is short
    await expect(inTenant(() => recurringService.create(bad as never, ctx()))).rejects.toThrow(/100\.00.*90\.00/);

    // one line is not a journal entry
    await expect(inTenant(() => recurringService.create({ ...bad, template: { lines: [{ accountId: expenseId, debitAmount: 5, creditAmount: 0 }] } } as never, ctx())))
      .rejects.toThrow(/at least two lines/);
    // a balanced template of ZEROES moves nothing and is refused too
    await expect(inTenant(() => recurringService.create({ ...bad, template: { lines: [
      { accountId: expenseId, debitAmount: 0, creditAmount: 0 }, { accountId: accrualId, debitAmount: 0, creditAmount: 0 },
    ] } } as never, ctx()))).rejects.toThrow(/non-zero/);

    // 🔴 nothing was stored by any of the four refusals
    expect((await pool.query(`SELECT count(*)::int n FROM recurring_rules WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(0);
  }, 60_000);

  it("🔴 a valid rule generates a DRAFT that moves NOTHING, and the run is recorded against its occurrence", async () => {
    const rule = await inTenant(() => recurringService.create({
      entity: "journal_entry", frequency: "monthly", dayOfMonth: 1,
      startsOn: "2026-06-01", template: template(3_000),
    } as never, ctx()));

    const tbBefore = await inTenant(() => reportsService.trialBalance());
    await makeDue(rule.id, "2026-06-01");
    const summary = await recurringGenerationService.runOnce("2026-06-01", orgId);
    expect(summary.generated).toBeGreaterThanOrEqual(1);

    const [run] = (await pool.query(
      `SELECT outcome, document_id, scheduled_for::text FROM recurring_runs WHERE rule_id = $1`, [rule.id])).rows;
    expect([run.outcome, run.scheduled_for]).toEqual(["generated", "2026-06-01"]);

    const [je] = (await pool.query(`SELECT status, date::text, entry_number FROM journal_entries WHERE id = $1`, [run.document_id])).rows;
    // 🔴 DRAFT. Approval is a human act about a document; a rule is about a pattern.
    expect(je.status).toBe("draft");
    expect(je.date).toBe("2026-06-01");
    // the number was ALLOCATED, not copied from the template — a copied number
    // collides on the second run and the rule fails every month after the first
    expect(je.entry_number).toBeTruthy();

    // 🔴 the zero-movement standard: a draft moves nothing in any report
    const tbAfter = await inTenant(() => reportsService.trialBalance());
    expect(tbAfter.totalDebit).toBe(tbBefore.totalDebit);
    expect(tbAfter.totalCredit).toBe(tbBefore.totalCredit);
  }, 90_000);

  it("🔴 the SAME occurrence cannot generate twice — the idempotency guarantee is the table's, not the caller's", async () => {
    const rule = await inTenant(() => recurringService.create({
      entity: "journal_entry", frequency: "monthly", dayOfMonth: 5,
      startsOn: "2026-07-05", template: template(1_200),
    } as never, ctx()));

    await makeDue(rule.id, "2026-07-05");
    await recurringGenerationService.runOnce("2026-07-05", orgId);
    const after1 = (await pool.query(`SELECT count(*)::int n FROM recurring_runs WHERE rule_id = $1`, [rule.id])).rows[0].n;

    // wind it back and run again: the occurrence is already recorded
    await makeDue(rule.id, "2026-07-05");
    await recurringGenerationService.runOnce("2026-07-05", orgId);
    const after2 = (await pool.query(`SELECT count(*)::int n FROM recurring_runs WHERE rule_id = $1`, [rule.id])).rows[0].n;
    expect(after2).toBe(after1);
    // …and exactly ONE entry exists for that occurrence
    expect((await pool.query(
      `SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1 AND date = '2026-07-05'`, [orgId])).rows[0].n).toBe(1);
  }, 90_000);

  it("🔴 a run into a CLOSED month FAILS LOUDLY with period_locked and writes no entry — a silent skip would be a gap in a series nobody watches", async () => {
    await inTenant(() => periodLocksService.lock({ period: "2026-08", userId }));
    const rule = await inTenant(() => recurringService.create({
      entity: "journal_entry", frequency: "monthly", dayOfMonth: 3,
      startsOn: "2026-08-03", template: template(900),
    } as never, ctx()));

    const before = (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;
    await makeDue(rule.id, "2026-08-03");
    await recurringGenerationService.runOnce("2026-08-03", orgId);

    const [run] = (await pool.query(
      `SELECT outcome, error_code, document_id FROM recurring_runs WHERE rule_id = $1`, [rule.id])).rows;
    expect([run.outcome, run.error_code, run.document_id]).toEqual(["failed", "period_locked", null]);
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(before);

    // 🔴 THE RULE ADVANCES PAST THE FAILURE, and that is deliberate: retrying a
    // locked period every day would produce one identical failure per day and
    // bury the signal. So A MISSED OCCURRENCE IS A RECORD, NOT A QUEUE ITEM —
    // reopening the month does not make the skipped entry appear, and the run
    // log is the only thing that says it is owed.
    //
    // (The schema comment claimed the opposite until 2026-09-22. It was the
    // comment that was wrong, not the code; this assertion now pins the
    // behaviour so the two cannot drift apart again.)
    const [r] = (await pool.query(`SELECT next_run_on::text FROM recurring_rules WHERE id = $1`, [rule.id])).rows;
    expect(r.next_run_on).toBe("2026-09-03");
    expect((await pool.query(
      `SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1 AND date = '2026-08-03'`, [orgId])).rows[0].n).toBe(0);
  }, 90_000);

  it("🔴 a PAUSED rule generates nothing, and resuming it picks the occurrence back up", async () => {
    const rule = await inTenant(() => recurringService.create({
      entity: "journal_entry", frequency: "monthly", dayOfMonth: 9,
      startsOn: "2026-09-09", template: template(450),
    } as never, ctx()));
    await pool.query(`UPDATE recurring_rules SET status = 'paused' WHERE id = $1`, [rule.id]);
    await makeDue(rule.id, "2026-09-09");
    await recurringGenerationService.runOnce("2026-09-09", orgId);
    expect((await pool.query(`SELECT count(*)::int n FROM recurring_runs WHERE rule_id = $1`, [rule.id])).rows[0].n).toBe(0);

    await pool.query(`UPDATE recurring_rules SET status = 'active' WHERE id = $1`, [rule.id]);
    await recurringGenerationService.runOnce("2026-09-09", orgId);
    expect((await pool.query(`SELECT count(*)::int n FROM recurring_runs WHERE rule_id = $1 AND outcome = 'generated'`, [rule.id])).rows[0].n).toBe(1);
  }, 90_000);
});
