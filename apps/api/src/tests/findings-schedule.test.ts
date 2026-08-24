/**
 * AI-5 — scheduled findings: cadence, the claim, one email to the owners of
 * the review, and the escalation that lands on the Dashboard.
 *
 * The properties that matter:
 *   1. The (org, period) run row is a CLAIM — a second pass in the same
 *      period does nothing (the recurring-job discipline, asserted by
 *      running twice, not by reasoning about uniqueness).
 *   2. 🔴 ONE email, to ACTIVE ADMINS ONLY (owner Q2) — a removed admin and
 *      a bookkeeper receive nothing. No email at all when nothing is open.
 *   3. 🔴 Viewing IS the dismissal, and only approver-level viewing counts —
 *      a viewer listing findings does NOT stamp the run.
 *   4. 🔴 Escalation is DERIVED (unviewed + old), never stored, and NOTHING
 *      auto-acknowledges at any age — an open finding stays open through
 *      scheduled runs and past the escalation interval.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool, PERMISSION_MATRIX } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { __setMailerForTests, type MailMessage } from "../lib/mailer";
import { findingsService } from "../services/findings.service";
import { findingsScheduleService, periodKeyFor } from "../services/findings.schedule.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[findings-schedule] no real DATABASE_URL — skipping.");

describe("periodKeyFor — calendar periods, the filing rhythm", () => {
  it("quarterly", () => {
    expect(periodKeyFor("quarterly", new Date("2026-01-15T00:00:00Z"))).toBe("2026-Q1");
    expect(periodKeyFor("quarterly", new Date("2026-08-24T00:00:00Z"))).toBe("2026-Q3");
    expect(periodKeyFor("quarterly", new Date("2026-12-31T00:00:00Z"))).toBe("2026-Q4");
  });
  it("monthly", () => {
    expect(periodKeyFor("monthly", new Date("2026-08-24T00:00:00Z"))).toBe("2026-08");
    expect(periodKeyFor("monthly", new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });
});

const SLUG = "ai5-sched";
const ADMIN_EMAIL = "ai5-admin@test.local";
const GONE_EMAIL = "ai5-gone@test.local";
const KEEPER_EMAIL = "ai5-keeper@test.local";

describeMaybe("AI-5 — scheduled findings", () => {
  let orgId = "";
  let companyId = "";
  let adminId = 0;
  let vendorId = 0;
  let sent: MailMessage[] = [];

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: adminId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usrs = `(SELECT id FROM users WHERE email IN ('${ADMIN_EMAIL}','${GONE_EMAIL}','${KEEPER_EMAIL}'))`;
    await pool.query(`DELETE FROM finding_runs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM finding_schedules WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM findings WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usrs}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usrs} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email IN ('${ADMIN_EMAIL}','${GONE_EMAIL}','${KEEPER_EMAIL}')`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    sent = [];
    __setMailerForTests({
      async send(m) {
        sent.push(m);
        return { delivered: true };
      },
    });

    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AI5 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'A5','1010101022','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    const mkUser = async (email: string, role: string, status: string) => {
      const id = (
        await pool.query(
          `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'U',' ','viewer',true) RETURNING id`,
          [email],
        )
      ).rows[0].id;
      await pool.query(
        `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,$4)`,
        [id, orgId, role, status],
      );
      return id as number;
    };
    adminId = await mkUser(ADMIN_EMAIL, "admin", "active");
    await mkUser(GONE_EMAIL, "admin", "removed");
    await mkUser(KEEPER_EMAIL, "bookkeeper", "active");

    vendorId = (
      await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'A5 Vendor') RETURNING id`, [orgId])
    ).rows[0].id;
    // A duplicate-bill pair — the open finding the scheduled run announces.
    for (const n of ["A5-1", "A5-2"]) {
      await pool.query(
        `INSERT INTO bills (organization_id, company_id, bill_number, vendor_id, date, status, subtotal, vat_amount, total)
         VALUES ($1,$2,$3,$4,'2026-08-01','approved',100,15,115)`,
        [orgId, companyId, n, vendorId],
      );
    }
  });

  afterAll(async () => {
    __setMailerForTests(null);
    await cleanup();
  });

  const NOW = new Date("2026-08-24T12:00:00Z"); // Q3 / month 08

  it("🔴 a due org runs ONCE per period — the second pass hits the claim and stops", async () => {
    const first = await findingsScheduleService.runOnce(NOW, orgId);
    expect(first).toMatchObject({ due: 1, ran: 1, alreadyRun: 0, failed: 0 });

    const second = await findingsScheduleService.runOnce(NOW, orgId);
    expect(second).toMatchObject({ due: 0, ran: 0, alreadyRun: 1 });

    const { rows } = await pool.query(
      `SELECT period_key, trigger, open_after FROM finding_runs WHERE organization_id = $1 AND trigger = 'scheduled'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].period_key).toBe("2026-Q3");
    expect(rows[0].open_after).toBeGreaterThan(0);
  });

  it("🔴 ONE email, to the ACTIVE ADMIN only — the removed admin and the bookkeeper receive nothing", async () => {
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(ADMIN_EMAIL);
    expect(sent[0].subject).toContain("2026-Q3");
    // Counts and a pointer — never finding contents (no vendor name, no amount).
    expect(sent[0].text).not.toContain("A5 Vendor");
    expect(sent[0].text).not.toContain("115");
    // The ladder is stated to the recipient: no second email will come.
    expect(sent[0].text).toContain("not receive a second email");
    const { rows } = await pool.query(
      `SELECT emailed_count FROM finding_runs WHERE organization_id = $1 AND trigger = 'scheduled'`,
      [orgId],
    );
    expect(rows[0].emailed_count).toBe(1);
  });

  it("the announced findings carry the delivery record (owner Q3: otherwise 'we told them' is unfalsifiable)", async () => {
    const { rows } = await pool.query(
      `SELECT delivered FROM findings WHERE organization_id = $1 AND status = 'open' LIMIT 1`,
      [orgId],
    );
    expect(rows[0].delivered).toHaveProperty("email_notice_run");
    expect(rows[0].delivered).toHaveProperty("email_notice_at");
  });

  it("🔴 viewing is the dismissal, and only approver-level viewing counts", async () => {
    // A viewer listing findings does NOT stamp the run.
    await inTenant(() => findingsService.markViewed("viewer", null));
    let { rows } = await pool.query(
      `SELECT viewed_at FROM finding_runs WHERE organization_id = $1 AND trigger = 'scheduled'`,
      [orgId],
    );
    expect(rows[0].viewed_at).toBeNull();

    // An admin listing findings does.
    await inTenant(() => findingsService.markViewed("admin", adminId));
    ({ rows } = await pool.query(
      `SELECT viewed_at, viewed_by FROM finding_runs WHERE organization_id = $1 AND trigger = 'scheduled'`,
      [orgId],
    ));
    expect(rows[0].viewed_at).not.toBeNull();
    expect(rows[0].viewed_by).toBe(adminId);
  });

  it("🔴 escalation is DERIVED — unviewed + old ⇒ true; viewed ⇒ false; young ⇒ false", async () => {
    // Reset to unviewed and backdate past the interval.
    await pool.query(
      `UPDATE finding_runs SET viewed_at = NULL, viewed_by = NULL, ran_at = now() - interval '8 days'
        WHERE organization_id = $1 AND trigger = 'scheduled'`,
      [orgId],
    );
    let status = await inTenant(() => findingsService.status());
    expect(status.escalated).toBe(true);

    // Young and unviewed: not yet escalated.
    await pool.query(
      `UPDATE finding_runs SET ran_at = now() - interval '2 days' WHERE organization_id = $1 AND trigger = 'scheduled'`,
      [orgId],
    );
    status = await inTenant(() => findingsService.status());
    expect(status.escalated).toBe(false);

    // Old but viewed: cleared.
    await pool.query(
      `UPDATE finding_runs SET ran_at = now() - interval '8 days', viewed_at = now() WHERE organization_id = $1 AND trigger = 'scheduled'`,
      [orgId],
    );
    status = await inTenant(() => findingsService.status());
    expect(status.escalated).toBe(false);
  });

  it("🔴 NOTHING auto-acknowledges, at any age — the open finding is still open after runs and escalation", async () => {
    const { rows } = await pool.query(
      `SELECT status FROM findings WHERE organization_id = $1 AND kind = 'duplicate_bill'`,
      [orgId],
    );
    expect(rows[0].status).toBe("open");
  });

  it("monthly opt-in changes the period key — a new period, a new run", async () => {
    await inTenant(() => findingsService.setCadence("monthly", adminId));
    const r = await findingsScheduleService.runOnce(NOW, orgId);
    expect(r).toMatchObject({ due: 1, ran: 1 }); // '2026-08' is a fresh key beside '2026-Q3'
    const { rows } = await pool.query(
      `SELECT period_key FROM finding_runs WHERE organization_id = $1 AND trigger = 'scheduled' ORDER BY id`,
      [orgId],
    );
    expect(rows.map((x) => x.period_key)).toEqual(["2026-Q3", "2026-08"]);
  });

  it("an on-demand run records its own row and never conflicts with scheduled periods", async () => {
    await inTenant(() => findingsService.run());
    await inTenant(() => findingsService.run());
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM finding_runs WHERE organization_id = $1 AND trigger = 'on_demand'`,
      [orgId],
    );
    expect(rows[0].n).toBe(2); // NULL period keys never conflict
  });

  it("grants: the cadence is approver-level — the bookkeeper negative", () => {
    const has = (role: string, action: string) =>
      PERMISSION_MATRIX.some((p) => p.role === role && p.resource === "findings" && p.action === action);
    expect(has("admin", "update")).toBe(true);
    expect(has("accountant", "update")).toBe(true);
    expect(has("bookkeeper", "update")).toBe(false);
    expect(has("viewer", "update")).toBe(false);
  });
});
