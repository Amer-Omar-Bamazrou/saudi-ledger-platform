/**
 * 🔴 BULK ACCEPT INTO A CLOSED MONTH IS REFUSED TRUTHFULLY (2026-09-16, the
 * pre-pilot batch; the seven-workflow audit's "bulk acceptance swallows the
 * closed-month refusal").
 *
 * Before: `acceptPending` flipped the rows to `accepted`, then `postMany`
 * caught the period-lock error PER ROW and returned a `failed` list nothing
 * in the web app read. The request answered 200, the row showed accepted,
 * the ledger had no entry, and the closed-month dialog never fired — the
 * exact accepted-but-unposted state the posting seam exists to make
 * impossible, reached through the one path that swallowed it.
 *
 * After: a row whose post is refused by the lock is put BACK to
 * `pending_review` inside the same transaction and reported under
 * `rejected` with the structured `period_closed` code. If nothing was
 * accepted, the request is the 423 itself (the dialog fires, as for every
 * other write); a mixed batch answers 200 with both lists. Any failure that
 * is NOT the lock is re-thrown: the request fails and rolls back whole,
 * never a partial silence.
 *
 * Cases the scope asked for: open-period bulk; closed-period bulk; a mixed
 * batch; no journal entry for a rejected row; the truthful response; retry
 * after unlock; idempotency; tenant isolation; and the branch NOT written —
 * a non-lock failure — proven by injection.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { transactionPostingService } from "../services/transactionPosting.service";
import { periodLocksService } from "../services/periodLocks.service";
import { PeriodLockedError } from "../lib/errors";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const SLUG = "bulk-accept-closed";
const SLUG_OTHER = "bulk-accept-closed-other";
const EMAIL = "bulk-accept-closed@test.local";
const CLOSED = "2026-03";

describeMaybe("bulk accept into a closed month is refused truthfully", () => {
  let orgId = "";
  let companyId = "";
  let otherOrgId = "";
  let otherCompanyId = "";
  let userId = 0;
  let rentId = 0;

  const tenant = (org: string, company: string) => async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: company, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };
  const inTenant = <T,>(fn: () => Promise<T>) => tenant(orgId, companyId)(fn);

  const cleanup = async () => {
    for (const slug of [SLUG, SLUG_OTHER]) {
      const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
      for (const t of ["journal_entry_lines", "journal_entries", "transactions", "period_locks", "audit_logs", "organization_memberships", "categories", "companies"]) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await pool.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
    }
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Bulk Accept Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'BA Co') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Other Org','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Other Co') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','BA',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) {
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    }
    rentId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'RENT_UTILITIES'`, [orgId])).rows[0].id;
    await inTenant(() => periodLocksService.lock({ period: CLOSED, notes: "closed for the test", userId }));
  });
  afterAll(cleanup);

  /**
   * Rows arrive through the product's own import path (pending, unposted),
   * then are made BULK-SAFE the way a reviewer would — categorised and
   * marked manually overridden — so bulk mode (no ids) sweeps them.
   */
  async function importRows(
    org: { orgId: string; companyId: string },
    rows: Array<{ date: string; description: string; amount: number }>,
    categoryId: number | null = rentId,
  ): Promise<number[]> {
    await tenant(org.orgId, org.companyId)(() =>
      transactionsService.upload({
        rows: rows.map((r) => ({ ...r, currency: "SAR", type: "debit" })),
        autoCategrize: false,
      } as never),
    );
    const ids: number[] = [];
    for (const r of rows) {
      const { rows: [row] } = await pool.query(
        `SELECT id FROM transactions WHERE organization_id = $1 AND description = $2 AND date = $3`,
        [org.orgId, r.description, r.date],
      );
      ids.push(row.id);
    }
    await pool.query(
      `UPDATE transactions SET category_id = $2, is_manually_overridden = true WHERE id = ANY($1::int[])`,
      [ids, categoryId],
    );
    return ids;
  }

  const rowState = async (id: number) =>
    (await pool.query(`SELECT review_status, journal_entry_id FROM transactions WHERE id = $1`, [id])).rows[0] as {
      review_status: string;
      journal_entry_id: number | null;
    };
  const entriesFor = async (id: number) =>
    (await pool.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE entry_number = $1 OR entry_number LIKE $2`,
      [`TXN-${id}`, `TXN-${id}-%`],
    )).rows[0].n as number;

  it("OPEN PERIOD: bulk accept accepts AND posts every safe row, and says so", async () => {
    const ids = await importRows({ orgId, companyId }, [
      { date: "2026-05-03", description: "OPEN ROW A", amount: 120 },
      { date: "2026-05-04", description: "OPEN ROW B", amount: 130 },
    ]);
    const r = await inTenant(() => transactionsService.acceptPending());
    expect(r).toMatchObject({ accepted: 2, posted: 2, rejected: [] });
    for (const id of ids) {
      const s = await rowState(id);
      expect(s.review_status).toBe("accepted");
      expect(s.journal_entry_id).not.toBeNull();
      expect(await entriesFor(id)).toBe(1);
    }
  });

  it("🔴 CLOSED PERIOD, bulk: the request IS the 423 — nothing accepted, no entry, the rows stay in review, the payload names every rejected row", async () => {
    const ids = await importRows({ orgId, companyId }, [
      { date: "2026-03-10", description: "CLOSED ROW A", amount: 210 },
      { date: "2026-03-11", description: "CLOSED ROW B", amount: 220 },
    ]);
    const auditBefore = (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_id = 'bulk-accept'`, [orgId])).rows[0].n;

    let caught: unknown;
    try {
      await inTenant(() => transactionsService.acceptPending());
    } catch (err) {
      caught = err;
    }
    expect(caught, "the refusal must reach the caller").toBeInstanceOf(PeriodLockedError);
    const e = caught as PeriodLockedError;
    expect(e.statusCode).toBe(423);
    expect(e.payload).toMatchObject({ code: "period_closed", period: CLOSED });
    const rejected = (e.payload as { rejected: Array<{ id: number; code: string; period: string }> }).rejected;
    expect(rejected.map((x) => x.id).sort()).toEqual([...ids].sort());
    expect(rejected.every((x) => x.code === "period_closed" && x.period === CLOSED)).toBe(true);

    for (const id of ids) {
      const s = await rowState(id);
      expect(s.review_status, "a refused row must NOT survive as accepted").toBe("pending_review");
      expect(s.journal_entry_id).toBeNull();
      expect(await entriesFor(id), "no journal entry for a rejected row").toBe(0);
    }
    const auditAfter = (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_id = 'bulk-accept'`, [orgId])).rows[0].n;
    expect(auditAfter, "nothing changed, so nothing is audited as accepted").toBe(auditBefore);
  });

  it("🔴 SINGLE named row in a closed month (the Review page's per-row Accept): the same 423", async () => {
    const [id] = await importRows({ orgId, companyId }, [{ date: "2026-03-12", description: "CLOSED SINGLE", amount: 5 }]);
    await expect(inTenant(() => transactionsService.acceptPending([id]))).rejects.toBeInstanceOf(PeriodLockedError);
    expect((await rowState(id)).review_status).toBe("pending_review");
    expect(await entriesFor(id)).toBe(0);
  });

  it("🔴 MIXED batch: 200 with the open row accepted+posted and the closed row named under `rejected`, still pending, with no entry; the audit row carries both counts", async () => {
    const [openId, closedId] = await importRows({ orgId, companyId }, [
      { date: "2026-05-20", description: "MIXED OPEN", amount: 310 },
      { date: "2026-03-20", description: "MIXED CLOSED", amount: 320 },
    ]);
    const r = await inTenant(() => transactionsService.acceptPending([openId, closedId]));
    expect(r.accepted).toBe(1);
    expect(r.posted).toBe(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ id: closedId, code: "period_closed", period: CLOSED, date: "2026-03-20" });
    expect(typeof r.rejected[0].reason).toBe("string");

    expect((await rowState(openId)).review_status).toBe("accepted");
    expect(await entriesFor(openId)).toBe(1);
    expect((await rowState(closedId)).review_status).toBe("pending_review");
    expect((await rowState(closedId)).journal_entry_id).toBeNull();
    expect(await entriesFor(closedId)).toBe(0);

    // Selected by CONTENT (audit ids are UUIDs, so "latest by id" is random):
    // the record for this act must name the rejected row.
    const { rows: [audit] } = await pool.query(
      `SELECT after_state AS after FROM audit_logs
        WHERE organization_id = $1 AND entity_id = 'bulk-accept' AND after_state->'rejectedIds' @> to_jsonb($2::int)`,
      [orgId, closedId],
    );
    expect(audit, "the audit record names the rejected row").toBeDefined();
    expect(audit.after).toMatchObject({ accepted: 1, posted: 1, rejected: 1, mode: "explicit" });
  });

  it("🔴 THE BRANCH NOT WRITTEN: a failure that is NOT the lock is re-thrown and the whole acceptance rolls back — never a partial silence", async () => {
    const ids = await importRows({ orgId, companyId }, [
      { date: "2026-05-21", description: "INJECT A", amount: 11 },
      { date: "2026-05-22", description: "INJECT B", amount: 12 },
    ]);
    const real = transactionPostingService.post.bind(transactionPostingService);
    const spy = vi.spyOn(transactionPostingService, "post").mockImplementation(async (txId: number) => {
      if (txId === ids[1]) throw new Error("injected: the chart is incomplete");
      return real(txId);
    });
    try {
      await expect(inTenant(() => transactionsService.acceptPending(ids))).rejects.toThrow("injected");
    } finally {
      spy.mockRestore();
    }
    for (const id of ids) {
      expect((await rowState(id)).review_status, "the accepted row rolls back with the failed one").toBe("pending_review");
      expect(await entriesFor(id)).toBe(0);
    }
  });

  it("TENANT ISOLATION: this org's lock refuses this org's row and does not touch the other org's row in the same month; ids named across orgs do nothing", async () => {
    const otherRent = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'RENT_UTILITIES'`, [otherOrgId])).rows[0].id;
    const [theirs] = await importRows({ orgId: otherOrgId, companyId: otherCompanyId }, [{ date: "2026-03-15", description: "THEIRS IN MARCH", amount: 77 }], otherRent);
    const [mine] = await importRows({ orgId, companyId }, [{ date: "2026-03-15", description: "MINE IN MARCH", amount: 88 }]);

    // Absence: naming the other org's row from this org's session accepts nothing.
    const cross = await inTenant(() => transactionsService.acceptPending([theirs]));
    expect(cross).toMatchObject({ accepted: 0, posted: 0, rejected: [] });
    expect((await rowState(theirs)).review_status).toBe("pending_review");

    // Presence: this org's row in the closed month is refused.
    await expect(inTenant(() => transactionsService.acceptPending([mine]))).rejects.toBeInstanceOf(PeriodLockedError);

    // Movement: the other org's row in the SAME month accepts and posts — the lock is this company's, not the platform's.
    const r = await tenant(otherOrgId, otherCompanyId)(() => transactionsService.acceptPending([theirs]));
    expect(r).toMatchObject({ accepted: 1, posted: 1, rejected: [] });
    const { rows: [je] } = await pool.query(
      `SELECT je.organization_id, je.company_id FROM transactions t JOIN journal_entries je ON je.id = t.journal_entry_id WHERE t.id = $1`,
      [theirs],
    );
    expect(je.organization_id).toBe(otherOrgId);
    expect(je.company_id).toBe(otherCompanyId);
  });

  it("RETRY after the admin unlocks: the rejected rows accept and post; IDEMPOTENT: accepting them again is a no-op with one entry each", async () => {
    const closedIds = (await pool.query(
      `SELECT id FROM transactions WHERE organization_id = $1 AND review_status = 'pending_review' AND date >= '2026-03-01' AND date < '2026-04-01' ORDER BY id`,
      [orgId],
    )).rows.map((r: { id: number }) => r.id);
    expect(closedIds.length).toBeGreaterThanOrEqual(4);

    await inTenant(() => periodLocksService.unlock(CLOSED));
    const r = await inTenant(() => transactionsService.acceptPending(closedIds));
    expect(r).toMatchObject({ accepted: closedIds.length, posted: closedIds.length, rejected: [] });
    for (const id of closedIds) {
      expect((await rowState(id)).review_status).toBe("accepted");
      expect(await entriesFor(id)).toBe(1);
    }

    const again = await inTenant(() => transactionsService.acceptPending(closedIds));
    expect(again).toMatchObject({ accepted: 0, posted: 0, rejected: [] });
    for (const id of closedIds) expect(await entriesFor(id), "a second accept must not post a second entry").toBe(1);
  });
});
