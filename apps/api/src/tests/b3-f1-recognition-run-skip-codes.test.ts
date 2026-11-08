/**
 * 🔴 Carry-over Batch 3, F-1 (the owner, 2026-11-07): the recognition run's skipped items carry a CODE.
 *
 * The run screen explains every skip in the reader's language, keyed on the structured code — the reason is the
 * server's English sentence, and rewording it must not be able to break the screen. The depreciation run's skips
 * already carried a code; the recognition run's carried only the sentence, so an Arabic screen could not say why a
 * schedule was skipped. Each case below is a skip a month end really meets, read from real rows:
 *  - a closed month: `period_closed` (the refusal's own code, reported per schedule);
 *  - a schedule with no row in the month: `recognition_period_not_scheduled`;
 *  - a schedule already recognised for the month: `recognition_period_already_recognised`;
 *  - an earlier month still open on the schedule: `recognition_out_of_order`.
 * The reasons are unchanged (phase11-accruals-prepayments.test.ts holds their words).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { recognitionSchedulesService } from "../services/accounting/recognitionSchedules.service";
import { periodLocksService } from "../services/periodLocks.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Batch 3 F-1 — every recognition-run skip carries a code (real rows)", () => {
  const SLUG = "b3-f1-run-codes";
  const EMAIL = "b3-f1-run-codes@test.local";
  let orgId = "", companyId = "", userId = 0;

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated", actorUserId: userId });
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
      await client.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      const tables = (await client.query(
        `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
      )).rows.map((r) => r.table_name as string);
      for (const t of tables) await client.query(`DELETE FROM "${t}" WHERE organization_id IN ${org}`);
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const accountId = async (code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
  type Skip = { reference: string; code: string; reason: string };
  const skipOf = (skipped: Skip[], reference: string) => {
    const s = skipped.find((x) => x.reference === reference);
    expect(s, `${reference} is reported as skipped`).toBeTruthy();
    expect(s!.reason.trim().length, `${reference}: the server's sentence is still there`).toBeGreaterThan(0);
    return s!;
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('B3 F1 run codes','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'B3 F1 Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','B3',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    const expense = await accountId("RENT_UTILITIES");
    const prepaid = await accountId("PREPAID_EXPENSES");
    for (const [reference, startPeriod] of [["B3-EARLY", "2026-03"], ["B3-LATER", "2026-05"]] as const) {
      const s = await inTenant(() => recognitionSchedulesService.create({
        kind: "prepayment", description: `B3 ${reference}`, totalAmount: 300, periods: 3, startPeriod,
        expenseAccountId: expense, balanceAccountId: prepaid, reference,
      }, userId));
      await inTenant(() => recognitionSchedulesService.activate(s.id, {}, userId));
    }
    await inTenant(() => periodLocksService.lock({ period: "2026-03", userId }));
  }, 90_000);

  afterAll(cleanup);

  it("🔴 a CLOSED month: the schedule due in it is skipped with `period_closed`; the one with no row there with `recognition_period_not_scheduled`; nothing posts", async () => {
    const run = await inTenant(() => recognitionSchedulesService.runPeriod({ period: "2026-03" }, userId));
    expect(run.posted).toEqual([]);
    expect(skipOf(run.skipped, "B3-EARLY").code).toBe("period_closed");
    expect(skipOf(run.skipped, "B3-LATER").code).toBe("recognition_period_not_scheduled");
  }, 60_000);

  it("🔴 an open month: the due schedule POSTS, and the one with an earlier month still open is skipped with `recognition_out_of_order`", async () => {
    const run = await inTenant(() => recognitionSchedulesService.runPeriod({ period: "2026-05" }, userId));
    expect(run.posted.map((p) => p.reference), "the later schedule posts its first month").toEqual(["B3-LATER"]);
    expect(run.postedTotal).toBe(100);
    expect(skipOf(run.skipped, "B3-EARLY").code).toBe("recognition_out_of_order");
  }, 60_000);

  it("🔴 the same month again: the posted schedule is skipped with `recognition_period_already_recognised`; every skip has a code", async () => {
    const run = await inTenant(() => recognitionSchedulesService.runPeriod({ period: "2026-05" }, userId));
    expect(run.posted).toEqual([]);
    expect(skipOf(run.skipped, "B3-LATER").code).toBe("recognition_period_already_recognised");
    expect(run.skipped.filter((s) => !s.code).map((s) => s.reference), "no skip without a code").toEqual([]);
  }, 60_000);
});
