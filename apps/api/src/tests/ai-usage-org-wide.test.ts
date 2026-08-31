/**
 * AI USAGE IS METERED FOR ORG-WIDE WORK TOO — the case that recorded nothing.
 *
 * ── 🔴 THE DEFECT ──────────────────────────────────────────────────────────
 * `ai_usage.company_id` was NOT NULL with `DEFAULT app_default_company_id()`,
 * which reads the `app.current_company_id` GUC. Request-scoped AI calls set
 * that GUC and inserted fine, so every test and every manual check passed.
 *
 * The SCHEDULED findings run does not set it: it opens its tenant connection
 * with an organization and no company, because it runs across the whole org
 * (`findings.schedule.service.ts:96`). The default evaluated to NULL, the
 * insert violated NOT NULL, `metered.ts` caught it and wrote to the console,
 * and **no row was ever recorded for any scheduled AI work.** Tokens spent,
 * latency real, meter empty.
 *
 * Found by reading a local server log during an unrelated browser run — which
 * is to say, by accident. Nothing in the suite could have caught it, because
 * every test that exercised metering did so through a request, and a request
 * always has a company.
 *
 * ── 🔴 WHY IT MATTERS OUT OF PROPORTION TO ITS SIZE ────────────────────────
 * Metering is the measurement half of R1. A figure the platform intends to
 * BILL from cannot have an entire category of usage missing, and this gap was
 * structurally invisible: the write was best-effort by design, so its failure
 * mode was silence. *Who finds out?* — nobody did.
 *
 * ── WHAT THIS ASSERTS ──────────────────────────────────────────────────────
 * The write path with NO company in scope, exercised the way the job does it,
 * and paired both ways:
 *
 *   PRESENCE  a row lands, carrying the organization.
 *   ABSENCE   its `company_id` is NULL — not a company picked arbitrarily.
 *             🔴 An arbitrary attribution would be worse than an absent one:
 *             precise, plausible, wrong, and billable.
 *   CONTRAST  the same call WITH a company in scope still records that
 *             company, so the fix did not trade one gap for another.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3161";
process.env.SESSION_SECRET ??= "ai-usage-orgwide-secret-0123456789abcdef";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "ai-usage-org-wide";

describeMaybe("AI usage is metered for org-wide work, with no company invented", () => {
  let orgId = "";
  let companyId = "";

  const wipe = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM ai_usage WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await wipe();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status)
         VALUES ('Meter Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Meter Co') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(wipe);

  /**
   * The job's own connection shape: an organization, and deliberately NO
   * company. Written out rather than imported so the test states the condition
   * it is about instead of inheriting it from a caller that might change.
   */
  async function inOrgOnly<T>(fn: () => Promise<T>): Promise<T> {
    const { beginTenantConnection } = await import("@workspace/db");
    const conn = await beginTenantConnection({ organizationId: orgId, role: "authenticated" });
    try {
      const out = await conn.run(fn);
      await conn.commit();
      return out;
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  }

  async function inOrgAndCompany<T>(fn: () => Promise<T>): Promise<T> {
    const { beginTenantConnection } = await import("@workspace/db");
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(fn);
      await conn.commit();
      return out;
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  }

  /** Writes one row through the real metering path, not a hand-built INSERT. */
  async function meterOnce(operation: string) {
    const { db, aiUsageTable } = await import("@workspace/db");
    await db.insert(aiUsageTable).values({
      operation,
      provider: "test-provider",
      model: "test-model",
      promptTokens: 11,
      completionTokens: 7,
      latencyMs: 42,
      ok: true,
    });
  }

  it("🔴 an org-wide call is RECORDED — it used to be silently dropped", async () => {
    await inOrgOnly(() => meterOnce("org_wide_op"));

    const rows = await pool.query(
      `SELECT organization_id, company_id, prompt_tokens FROM ai_usage
       WHERE organization_id = $1 AND operation = 'org_wide_op'`,
      [orgId],
    );
    // PRESENCE. Before the fix this was zero rows and nothing said so.
    expect(rows.rowCount, "the org-wide metering row was not recorded").toBe(1);
    expect(rows.rows[0].organization_id).toBe(orgId);
    expect(rows.rows[0].prompt_tokens).toBe(11);
  });

  it("🔴 its company is NULL — not a company chosen on the tenant's behalf", async () => {
    const rows = await pool.query(
      `SELECT company_id FROM ai_usage WHERE organization_id = $1 AND operation = 'org_wide_op'`,
      [orgId],
    );
    expect(
      rows.rows[0].company_id,
      "an org-wide run was attributed to a specific company. That figure is billable, " +
        "and a precise wrong attribution is worse than an absent one.",
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    ).toBeNull();
  });

  it("a company-scoped call still records its company — the fix traded nothing away", async () => {
    await inOrgAndCompany(() => meterOnce("company_scoped_op"));

    const rows = await pool.query(
      `SELECT company_id FROM ai_usage WHERE organization_id = $1 AND operation = 'company_scoped_op'`,
      [orgId],
    );
    expect(rows.rowCount).toBe(1);
    // The contrast is the point: if this were also NULL, the "fix" would have
    // been to stop recording companies at all.
    expect(rows.rows[0].company_id).toBe(companyId);
  });

  it("🔴 the column is nullable in the DATABASE, not just in the Drizzle schema", async () => {
    /**
     * Verified against `information_schema`, never estimated from the schema
     * file — the standing rule for grants and constraints. A Drizzle type that
     * says optional over a column that is still NOT NULL would typecheck
     * perfectly and fail at runtime, which is exactly how this defect behaved.
     */
    const col = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'ai_usage' AND column_name = 'company_id'`,
    );
    expect(col.rows[0]?.is_nullable).toBe("YES");

    const org = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'ai_usage' AND column_name = 'organization_id'`,
    );
    // And the organization is still mandatory: usage that belongs to no tenant
    // is not a meter reading, it is a leak in the accounting.
    expect(org.rows[0]?.is_nullable).toBe("NO");
  });
});
