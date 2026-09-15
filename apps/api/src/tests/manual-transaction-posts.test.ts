/**
 * A MANUALLY CREATED TRANSACTION POSTS TO THE LEDGER — through the same seam
 * an imported one does, with the same refusals.
 *
 * 🔴 WHY THIS EXISTS (2026-09-15, workflow audit W7 B3): `transactionsService
 * .create` inserted the row as accepted and never called
 * `transactionPostingService.post`. A hand-typed row appeared in the
 * transactions list and never in the ledger — the dashboard-versus-ledger
 * divergence the original flaw #1 closed for IMPORTS, reopened for manual rows.
 *
 * Cases the owner asked for: success (correct accounts, balanced, dated,
 * linked, tenant-scoped, audited); an unpostable row; a closed period (the row
 * must NOT survive as accepted-but-unposted, and the caller must see the
 * refusal); idempotency (a second post of the same row is a no-op, never a
 * duplicate entry); tenant isolation; and imported rows unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { transactionPostingService } from "../services/transactionPosting.service";
import { periodLocksService } from "../services/periodLocks.service";
import { PeriodLockedError } from "../lib/errors";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const SLUG = "manual-txn-posts";
const SLUG_OTHER = "manual-txn-posts-other";
const EMAIL = "manual-txn@test.local";
const CLOSED = "2026-03";

describeMaybe("a manually created transaction posts to the ledger", () => {
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Manual Txn Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'MT Co') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Other Org','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Other Co') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','MT',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) {
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    }
    rentId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'RENT_UTILITIES'`, [orgId])).rows[0].id;
    await inTenant(() => periodLocksService.lock({ period: CLOSED, notes: "closed for the test", userId }));
  });
  afterAll(cleanup);

  const entryFor = async (txId: number) =>
    (await pool.query(
      `SELECT je.id, je.entry_number, je.date::text, je.status, je.organization_id, je.company_id,
              (SELECT json_agg(json_build_object('code', c.system_code, 'dr', l.debit_amount::text, 'cr', l.credit_amount::text) ORDER BY l.id)
                 FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = je.id) AS lines
         FROM transactions t JOIN journal_entries je ON je.id = t.journal_entry_id WHERE t.id = $1`,
      [txId],
    )).rows[0];

  it("🔴 SUCCESS: a categorised debit posts Dr expense / Cr CASH, balanced, on the row's date, in the row's tenant, linked and audited", async () => {
    const tx = await inTenant(() =>
      transactionsService.create({ date: "2026-05-10", description: "Office rent — May", amount: 3000, currency: "SAR", type: "debit", categoryId: rentId }),
    );
    const je = await entryFor(tx.id);
    expect(je, "the row must be LINKED to a journal entry").toBeDefined();
    expect(je.entry_number).toBe(`TXN-${tx.id}`);
    expect(je.date).toBe("2026-05-10");
    expect(je.status).toBe("posted");
    expect(je.organization_id).toBe(orgId);
    expect(je.company_id).toBe(companyId);
    expect(je.lines).toEqual([
      { code: "RENT_UTILITIES", dr: "3000.00", cr: "0.00" },
      { code: "CASH", dr: "0.00", cr: "3000.00" },
    ]);
    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_type = 'transaction' AND entity_id = $2::text`, [orgId, String(tx.id)]);
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it("an UNCATEGORISED manual row posts to SUSPENSE, never to an expense — the same rule as an import", async () => {
    const tx = await inTenant(() =>
      transactionsService.create({ date: "2026-05-11", description: "Unknown payee", amount: 250, currency: "SAR", type: "debit" }),
    );
    expect((await entryFor(tx.id)).lines.map((l: { code: string }) => l.code)).toEqual(["SUSPENSE", "CASH"]);
  });

  it("🔴 CLOSED PERIOD: the create is refused, the caller sees it, and NO accepted-but-unposted row survives", async () => {
    const before = (await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE organization_id = $1`, [orgId])).rows[0].n;
    await expect(
      inTenant(() => transactionsService.create({ date: "2026-03-15", description: "Backdated into a closed month", amount: 100, currency: "SAR", type: "debit", categoryId: rentId })),
    ).rejects.toBeInstanceOf(PeriodLockedError);
    const after = (await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE organization_id = $1`, [orgId])).rows[0].n;
    expect(after, "the INSERT must roll back with the refused post").toBe(before);
    const orphans = (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND date = '2026-03-15'`, [orgId])).rows[0].n;
    expect(orphans).toBe(0);
  });

  it("IDEMPOTENT: posting an already-posted row again is a no-op — one entry, not two", async () => {
    const tx = await inTenant(() =>
      transactionsService.create({ date: "2026-05-12", description: "Idempotency probe", amount: 40, currency: "SAR", type: "debit", categoryId: rentId }),
    );
    const again = await inTenant(() => transactionPostingService.post(tx.id));
    expect(again).toBeNull();
    const n = (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND (entry_number = $2 OR entry_number LIKE $3)`, [orgId, `TXN-${tx.id}`, `TXN-${tx.id}-%`])).rows[0].n;
    expect(n).toBe(1);
  });

  it("TENANT ISOLATION: the other org's ledger never sees this org's manual row, and its own row posts in its own company", async () => {
    const mine = await inTenant(() =>
      transactionsService.create({ date: "2026-05-13", description: "Mine", amount: 10, currency: "SAR", type: "debit" }),
    );
    const theirs = await tenant(otherOrgId, otherCompanyId)(() =>
      transactionsService.create({ date: "2026-05-13", description: "Theirs", amount: 20, currency: "SAR", type: "debit" }),
    );
    const mineJe = await entryFor(mine.id);
    const theirsJe = await entryFor(theirs.id);
    expect(mineJe.organization_id).toBe(orgId);
    expect(theirsJe.organization_id).toBe(otherOrgId);
    expect(theirsJe.company_id).toBe(otherCompanyId);
    // presence AND absence AND movement: each org's cash line is its own
    const cash = async (org: string) =>
      (await pool.query(`SELECT coalesce(sum(l.credit_amount),0)::text AS cr FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.organization_id = $1 AND c.system_code = 'CASH'`, [org])).rows[0].cr;
    expect(Number(await cash(otherOrgId))).toBe(20);
    expect(Number(await cash(orgId))).toBeGreaterThanOrEqual(3300);
  });

  it("IMPORTED rows are unchanged: upload lands pending and unposted; accept posts it through the same seam", async () => {
    await inTenant(() =>
      transactionsService.upload({ rows: [{ date: "2026-05-14", description: "IMPORTED ROW 77", amount: 500, currency: "SAR", type: "debit" }], autoCategrize: false } as never),
    );
    const { rows: [row] } = await pool.query(`SELECT id, review_status, journal_entry_id FROM transactions WHERE organization_id = $1 AND description LIKE 'IMPORTED ROW 77%'`, [orgId]);
    expect(row.review_status).toBe("pending_review");
    expect(row.journal_entry_id).toBeNull();
    await inTenant(() => transactionsService.acceptPending([row.id]));
    expect((await entryFor(row.id)).lines.map((l: { code: string }) => l.code)).toEqual(["SUSPENSE", "CASH"]);
  });
});
