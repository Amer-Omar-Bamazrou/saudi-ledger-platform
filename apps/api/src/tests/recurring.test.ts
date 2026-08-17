/**
 * A3 — recurring documents.
 *
 * The properties worth testing are not "it makes an invoice". They are:
 *   1. **It generates a DRAFT and never issues** — issuance consumes an ICV and
 *      a ZATCA chain position, and is irreversible.
 *   2. **A locked period FAILS LOUDLY** — a skipped recurring invoice means a
 *      customer was not billed and nothing says so.
 *   3. **Occurrences cannot double-generate**, even under a concurrent job.
 *   4. **Month-end dates do not drift** — the 31st is the common choice and does
 *      not exist in five months of the year.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { recurringGenerationService } from "../services/recurring/generation.service";
import { nextOccurrence } from "../services/recurring/recurring.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[recurring] no real DATABASE_URL — skipping.");

const SLUG = "a3-recurring";
const EMAIL = "a3-recurring@test.local";

// ── Pure date arithmetic: no DB needed ──────────────────────────────────────

describe("A3 — occurrence dates do not drift", () => {
  it("🔴 a rule set for the 31st does NOT roll into the next month", () => {
    // Naive date arithmetic turns 31 Feb into 3 March, and a month-end rule then
    // walks forward through the year. `dayOfMonth` is the INTENT; the date is
    // derived from it each period.
    expect(nextOccurrence("2026-01-31", "monthly", 31)).toBe("2026-02-28");
    expect(nextOccurrence("2026-02-28", "monthly", 31)).toBe("2026-03-31");
    expect(nextOccurrence("2026-03-31", "monthly", 31)).toBe("2026-04-30");
    // The intent survives a short month rather than being lost to it.
    expect(nextOccurrence("2026-04-30", "monthly", 31)).toBe("2026-05-31");
  });

  it("handles a leap year", () => {
    expect(nextOccurrence("2028-01-31", "monthly", 31)).toBe("2028-02-29");
  });

  it("handles quarterly and yearly", () => {
    expect(nextOccurrence("2026-01-15", "quarterly", 15)).toBe("2026-04-15");
    expect(nextOccurrence("2026-11-30", "quarterly", 31)).toBe("2027-02-28");
    expect(nextOccurrence("2026-06-01", "yearly", 1)).toBe("2027-06-01");
  });
});

// ── Generation ──────────────────────────────────────────────────────────────

describeMaybe("A3 — generation", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let generatedRuleId = "";
  let lockedRuleId = "";

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM recurring_runs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM recurring_rules WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM period_locks WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Recur Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'Recur Co','1010101010','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','RC',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'Tenant','مستأجر') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(cleanup);

  let seq = 0;
  async function makeRule(nextRunOn: string): Promise<string> {
    seq += 1;
    const template = {
      invoiceNumber: `RENT-${seq}-${Date.now()}`,
      customerId,
      items: [{ description: "Monthly rent", quantity: 1, unitPrice: 5000, vatRate: 15 }],
    };
    const { rows } = await pool.query(
      `INSERT INTO recurring_rules
         (organization_id, company_id, entity, template, frequency, day_of_month, starts_on, next_run_on, created_by)
       VALUES ($1,$2,'invoice',$3,'monthly',1,$4::date,$4::date,$5) RETURNING id`,
      [orgId, companyId, JSON.stringify(template), nextRunOn, userId],
    );
    return rows[0].id;
  }

  /**
   * Retire a rule after its test.
   *
   * 🔴 Not cosmetic. `runOnce` is global by design — it drains every due rule —
   * so a rule left active keeps appearing in later passes and inflates their
   * counts. Same class as the outbox suites needing an organizationId scope:
   * a job that is correctly global makes tests interfere unless they clean up
   * after themselves.
   */
  const retire = (ruleId: string) =>
    pool.query(`UPDATE recurring_rules SET status = 'paused' WHERE id = $1`, [ruleId]);

  const runsFor = async (ruleId: string) =>
    (await pool.query(`SELECT * FROM recurring_runs WHERE rule_id = $1 ORDER BY scheduled_for`, [ruleId])).rows;

  it("🔴 generates a DRAFT — never an issued invoice", async () => {
    const ruleId = await makeRule("2026-09-01");
    const result = await recurringGenerationService.runOnce("2026-09-01", orgId);
    expect(result.generated).toBe(1);

    const [run] = await runsFor(ruleId);
    expect(run.outcome).toBe("generated");
    expect(run.document_id).toBeTruthy();

    const { rows } = await pool.query(`SELECT status, invoice_hash, icv, qr_code FROM invoices WHERE id = $1`, [
      run.document_id,
    ]);
    // 🔴 The whole point. An issued invoice would carry a hash, an ICV and a QR,
    // and would have consumed a ZATCA chain position that cannot be given back.
    expect(rows[0].status).toBe("draft");
    expect(rows[0].invoice_hash).toBeNull();
    expect(rows[0].icv).toBeNull();
    expect(rows[0].qr_code).toBeNull();
    generatedRuleId = ruleId;
  });

  it("advances to the next occurrence after a successful run", async () => {
    const { rows } = await pool.query(
      `SELECT next_run_on::text AS d FROM recurring_rules WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orgId],
    );
    expect(rows[0].d).toBe("2026-10-01");
  });

  it("🔴 does not double-generate — the occurrence is claimed", async () => {
    const ruleId = await makeRule("2026-09-05");
    await recurringGenerationService.runOnce("2026-09-05", orgId);

    // Re-point the rule at the SAME occurrence, as a duplicate job pass or a
    // second instance would effectively do.
    await pool.query(`UPDATE recurring_rules SET next_run_on = '2026-09-05' WHERE id = $1`, [ruleId]);
    const second = await recurringGenerationService.runOnce("2026-09-05", orgId);

    expect(second.alreadyRun).toBe(1);
    expect(second.generated).toBe(0);
    expect(await runsFor(ruleId)).toHaveLength(1);
    await retire(ruleId);
  });

  it("🔴 a LOCKED PERIOD fails loudly with a reason — it does not skip silently", async () => {
    // A skipped recurring invoice means a customer was not billed and nothing
    // says so. Worse than the ZATCA outbox: an unsubmitted invoice eventually
    // draws a complaint from ZATCA; an unsent one has no external party at all.
    await pool.query(
      `INSERT INTO period_locks (organization_id, company_id, period, locked_by) VALUES ($1,$2,'2026-11',$3)`,
      [orgId, companyId, userId],
    );

    const ruleId = await makeRule("2026-11-01");
    lockedRuleId = ruleId;
    const result = await recurringGenerationService.runOnce("2026-11-01", orgId);

    // Assert on THIS rule rather than on global counts — the pass legitimately
    // drains every due rule, so a total says nothing about this one.
    const [run] = await runsFor(ruleId);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(run.outcome).toBe("failed");
    // Machine-readable, so the UI can say what to do rather than show a stack.
    expect(run.error_code).toBe("period_locked");
    expect(run.error_detail).toMatch(/locked/i);

    // And nothing was created — a failed run leaves no half-made document.
    expect(run.document_id).toBeNull();
  });

  it("advances PAST a failed occurrence rather than retrying it daily", async () => {
    // The failure is already recorded and visible. Retrying the same locked
    // period every day would produce one identical failure per day and bury the
    // signal the record exists to send.
    const { rows } = await pool.query(`SELECT next_run_on::text AS d FROM recurring_rules WHERE id = $1`, [
      lockedRuleId,
    ]);
    expect(rows[0].d).toBe("2026-12-01");
  });

  it("ignores paused rules and rules past their end date", async () => {
    const paused = await makeRule("2026-09-10");
    await pool.query(`UPDATE recurring_rules SET status = 'paused' WHERE id = $1`, [paused]);

    const ended = await makeRule("2026-09-10");
    await pool.query(`UPDATE recurring_rules SET ends_on = '2026-08-01' WHERE id = $1`, [ended]);

    await recurringGenerationService.runOnce("2026-09-10", orgId);
    // Neither produced a run — which is the property, regardless of what other
    // rules the pass happened to pick up.
    expect(await runsFor(paused)).toHaveLength(0);
    expect(await runsFor(ended)).toHaveLength(0);
  });

  it("does not generate before the rule is due", async () => {
    const future = await makeRule("2027-01-01");
    await recurringGenerationService.runOnce("2026-12-01", orgId);
    expect(await runsFor(future)).toHaveLength(0);
  });
});
