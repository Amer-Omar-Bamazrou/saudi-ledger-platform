/**
 * M22 — the closed-month refusal is a STRUCTURED explanation, not an error
 * string.
 *
 * The contract under test: every path that hits a closed month throws a 423
 * whose PAYLOAD carries `code: "period_closed"` + `period` + `lockedAt`. The
 * web's single dialog keys on that code — never on the message text — so these
 * tests pin the payload shape hard and treat the message as copy: asserted
 * only for plain language (the owner's rule: no accounting vocabulary in a
 * primary workflow), not for exact wording.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { periodLocksService } from "../services/periodLocks.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[closed-months] no real DATABASE_URL — skipping.");
}

const CLOSED = "2026-03";

describeMaybe("M22 — the 423 the client explains", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.88" }, fn),
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
      await pool.query(`DELETE FROM period_locks WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM invoice_items WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM invoices WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM customers WHERE organization_id = $1`, [orgId]);
    }
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email = 'closed-months@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name = 'CLOSED Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'closed-months-test'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('CLOSED Org','closed-months-test') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'CLOSED Co','1010101016','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('closed-months@test.local','Closer',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'C','ع') RETURNING id`, [orgId])
    ).rows[0].id;

    // Close the month through the real service (audited, company-scoped).
    await inTenant(() => periodLocksService.lock({ period: CLOSED, notes: "test close", userId }));
  });

  afterAll(async () => {
    await cleanup();
  });

  async function refusal(fn: () => Promise<unknown>): Promise<any> {
    try {
      await inTenant(fn);
    } catch (err) {
      return err;
    }
    throw new Error("expected a 423 refusal, got success");
  }

  it("🔴 THE CONTRACT: the 423 payload carries code/period/lockedAt", async () => {
    const err = await refusal(() =>
      invoicesService.create(
        { date: `${CLOSED}-15`, customerId, items: [{ description: "x", quantity: 1, unitPrice: 100, vatRate: 15 }] },
        userId,
      ),
    );
    expect(err.statusCode).toBe(423);
    // 🔴 The dialog reads THESE, never the message — pin them exactly.
    expect(err.payload).toMatchObject({
      code: "period_closed",
      period: CLOSED,
    });
    expect(err.payload.lockedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("the same contract holds on a journal entry (a different caller of the same gate)", async () => {
    // JE lines post to accountIds — take two from the org's seeded chart (the
    // org-seed trigger created it on INSERT).
    const { rows: accounts } = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 ORDER BY id LIMIT 2`,
      [orgId],
    );
    const err = await refusal(() =>
      journalEntriesService.create(
        {
          entryNumber: "JE-CLOSED-1",
          date: `${CLOSED}-10`,
          description: "into a closed month",
          lines: [
            { accountId: accounts[0].id, accountName: "A", debitAmount: 100, creditAmount: 0 },
            { accountId: accounts[1].id, accountName: "B", debitAmount: 0, creditAmount: 100 },
          ],
        } as never,
        userId,
      ),
    );
    expect(err.statusCode).toBe(423);
    expect(err.payload?.code).toBe("period_closed");
  });

  it("the fallback MESSAGE is plain language, not accountant vocabulary", async () => {
    // The message is copy and may be reworded — the dialog does not read it.
    // What is pinned is the vocabulary RULE: it must speak of closed books in
    // plain words and must not tell a non-accountant to "post a reversing
    // entry" or call the month a "period lock".
    const err = await refusal(() =>
      invoicesService.create(
        { date: `${CLOSED}-20`, customerId, items: [{ description: "y", quantity: 1, unitPrice: 50 }] },
        userId,
      ),
    );
    expect(err.message).toMatch(/books .* closed/i);
    expect(err.message).not.toMatch(/reversing entry/i);
    expect(err.message).not.toMatch(/period lock/i);
  });

  it("an OPEN month is unaffected — the gate refuses the month, not the tenant", async () => {
    const inv = await inTenant(() =>
      invoicesService.create(
        { date: "2026-04-05", customerId, items: [{ description: "open month", quantity: 1, unitPrice: 100, vatRate: 15 }] },
        userId,
      ),
    );
    expect(inv.status).toBe("draft");
  });

  it("reopening lifts the refusal", async () => {
    await inTenant(() => periodLocksService.unlock(CLOSED));
    const inv = await inTenant(() =>
      invoicesService.create(
        { date: `${CLOSED}-25`, customerId, items: [{ description: "after reopen", quantity: 1, unitPrice: 10 }] },
        userId,
      ),
    );
    expect(inv.id).toBeGreaterThan(0);
    // Re-close for any later assertions and to leave the fixture as documented.
    await inTenant(() => periodLocksService.lock({ period: CLOSED, userId }));
  });

  it("🔴 a SCHEDULE reads the same words a human does", async () => {
    // The recurring generator records `err.message` as the failed run's
    // errorDetail. Because the plain-language rewrite lives in the SOURCE
    // error (checkPeriodOpen), the schedule inherits it — this pins that a
    // rule failing against a closed month records the same explanation a
    // human sees, rather than a divergent internal string.
    const err = await refusal(() =>
      invoicesService.create(
        { date: `${CLOSED}-11`, customerId, items: [{ description: "z", quantity: 1, unitPrice: 10 }] },
        userId,
      ),
    );
    const asRecorded = err instanceof Error ? err.message.slice(0, 500) : "";
    expect(asRecorded).toMatch(/books .* closed/i);
    expect(asRecorded).not.toMatch(/reversing entry/i);
  });
});
