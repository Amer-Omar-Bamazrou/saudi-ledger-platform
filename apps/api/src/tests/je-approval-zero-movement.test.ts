/**
 * JE draft/approval — ZERO-MOVEMENT proof (M10.2). THE TEMPLATE for every entity.
 *
 * The single most important invariant of the whole draft/approval feature
 * (spec §7): a PENDING draft must move ZERO balances in EVERY GL-backed report,
 * and APPROVAL is what posts it. This test proves exactly that, end to end,
 * through the REAL report services (not hand-written SQL): it creates a balanced
 * journal-entry draft, asserts every money report shows zero, approves it, then
 * asserts the expected movement appears — and that the create/approve transitions
 * are audited.
 *
 * M10.3–M10.5 each add their entity's version of this test in the same shape:
 *   draft → assert zero everywhere → approve → assert movement → assert audit.
 *
 * Runs inside a real tenant transaction (RLS-scoped), mirroring a request. Needs
 * a real database; skips when DATABASE_URL is unset or the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[je-approval] no real DATABASE_URL — skipping zero-movement test.");
}

describeMaybe("JE draft/approval — a pending draft moves zero balances; approval posts it", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let expenseCatId = 0;
  let cashCatId = 0;

  const DATE = "2026-05-15";
  const AMOUNT = 100;

  /** Run fn inside this tenant's RLS transaction + audit context (like a request). */
  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.9" }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    if (orgId) {
      await pool.query(
        `DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id = $1)`,
        [orgId],
      );
      await pool.query(`DELETE FROM journal_entries WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM categories WHERE organization_id = $1`, [orgId]);
    }
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email = 'je-approval@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name = 'JE-APPR Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'je-appr'`);
  };

  beforeAll(async () => {
    await pool.query(`DELETE FROM organizations WHERE slug = 'je-appr'`);
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('JE-APPR Org','je-appr') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'JE-APPR Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('je-approval@test.local','JE Approver',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    // Chart of accounts: one expense, one asset — org-scoped (explicit org, no request GUC here).
    expenseCatId = (
      await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type) VALUES ($1,'Office Expense','مصروف مكتبي','expense') RETURNING id`, [orgId])
    ).rows[0].id;
    cashCatId = (
      await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type) VALUES ($1,'Cash','نقد','asset') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  let jeId = 0;

  it("creates a balanced draft (pending) journal entry", async () => {
    const je = await inTenant(() =>
      journalEntriesService.create(
        {
          entryNumber: "JE-ZERO-1",
          date: DATE,
          description: "Zero-movement draft",
          lines: [
            { accountId: expenseCatId, accountName: "Office Expense", debitAmount: AMOUNT, creditAmount: 0 },
            { accountId: cashCatId, accountName: "Cash", debitAmount: 0, creditAmount: AMOUNT },
          ],
        },
        userId,
      ),
    );
    jeId = je.id;
    expect(je.status).toBe("draft");
    expect(je.totalDebit).toBe(AMOUNT);
    expect(je.totalCredit).toBe(AMOUNT);
  });

  it("PENDING: moves ZERO in every GL-backed report", async () => {
    await inTenant(async () => {
      const tb = await reportsService.trialBalance();
      expect(tb.accounts).toHaveLength(0);
      expect(tb.totalDebit).toBe(0);
      expect(tb.totalCredit).toBe(0);

      const is = await reportsService.incomeStatement();
      expect(is.totalExpenses).toBe(0);
      expect(is.totalRevenue).toBe(0);
      expect(is.netIncome).toBe(0);

      const gl = await reportsService.generalLedger(String(expenseCatId));
      expect(gl.movements).toHaveLength(0);
      expect(gl.closingBalance).toBe(0);

      const jr = await reportsService.journalReport();
      expect(jr.count).toBe(0);

      const bs = await reportsService.balanceSheet();
      // no posted equity/retained-earnings movement from the draft
      expect(bs.equity.retainedEarnings).toBe(0);
    });
  });

  it("PENDING: the draft is still visible in the operational activity worklist", async () => {
    // Spec §7/§8: drafts may appear in operational views, just never in financial aggregates.
    await inTenant(async () => {
      const act = await reportsService.activity();
      expect(act.hasDraft).toBeGreaterThanOrEqual(1);
      expect(act.hasPosted).toBe(0);
    });
  });

  it("APPROVE posts the entry to the GL", async () => {
    const posted = await inTenant(() => journalEntriesService.approve(jeId, userId));
    expect(posted.status).toBe("posted");
    expect(posted.postedAt).not.toBeNull();
  });

  it("APPROVED: the expected movement now appears in every GL-backed report", async () => {
    await inTenant(async () => {
      const tb = await reportsService.trialBalance();
      expect(tb.totalDebit).toBe(AMOUNT);
      expect(tb.totalCredit).toBe(AMOUNT);
      expect(tb.balanced).toBe(true);

      const is = await reportsService.incomeStatement();
      expect(is.totalExpenses).toBe(AMOUNT);
      expect(is.netIncome).toBe(-AMOUNT);

      const gl = await reportsService.generalLedger(String(expenseCatId));
      expect(gl.movements).toHaveLength(1);
      expect(gl.movements[0].debit).toBe(AMOUNT);
      expect(gl.closingBalance).toBe(AMOUNT);

      const jr = await reportsService.journalReport();
      expect(jr.count).toBe(1);
      expect(jr.balanced).toBe(true);
    });
  });

  it("records the create and approve transitions in the audit trail", async () => {
    const rows = (
      await pool.query(
        `SELECT action FROM audit_logs WHERE entity_type = 'journal_entry' AND entity_id = $1 ORDER BY created_at ASC`,
        [String(jeId)],
      )
    ).rows.map((r) => r.action);
    expect(rows).toContain("create");
    expect(rows).toContain("approve");
  });
});
