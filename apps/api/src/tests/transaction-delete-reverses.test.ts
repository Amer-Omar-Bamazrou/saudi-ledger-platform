/**
 * DELETING A POSTED TRANSACTION REVERSES ITS LEDGER ENTRY — never orphans it.
 *
 * 🔴 WHY THIS EXISTS (2026-09-15, workflow audit W5 G1 / W7 B4): `remove`
 * guarded settlements only and deleted the row; the FK nulled the link and the
 * journal entry stayed in the books with nothing pointing at it. The P&L kept
 * the expense, ledger cash stayed reduced, and the cash reconciliation folded
 * the orphan into its `ledger_only` residual so it read as explained. Raw API
 * only (no page calls DELETE /transactions/:id), which is exactly why the API
 * had to be safe on its own.
 *
 * The property: after a delete, the ledger's cash position equals what it was
 * BEFORE the row was ever accepted, the original entry is still in the books
 * (status reversed, its mirror posted — the trail survives), and the cash
 * reconciliation's ledger-only residual is unchanged by the whole episode.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { invoicesService } from "../services/invoices.service";
import { cashService } from "../services/cash.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const SLUG = "txn-delete-reverses";
const SLUG_OTHER = "txn-delete-reverses-other";
const EMAIL = "txn-delete@test.local";

describeMaybe("deleting a posted transaction reverses its entry; settlements still refuse", () => {
  let orgId = "";
  let companyId = "";
  let otherOrgId = "";
  let otherCompanyId = "";
  let userId = 0;
  let customerId = 0;
  let bankId = 0;

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
      await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
      for (const t of ["transactions", "journal_entry_lines", "journal_entries", "invoice_items", "einvoice_documents", "invoices", "customers", "bank_accounts", "audit_logs", "organization_memberships", "categories", "companies"]) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await pool.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
    }
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Del Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'Del Co','1010505052','399999999933303') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Del Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Del Other Co') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','Del',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) {
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    }
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Del Customer') RETURNING id`, [orgId])).rows[0].id;
    bankId = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Del SAR','ANB') RETURNING id`, [orgId, companyId])).rows[0].id;
  });
  afterAll(cleanup);

  async function uploadRow(row: { date: string; description: string; amount: number; type: "debit" | "credit" }) {
    await inTenant(() => transactionsService.upload({ rows: [{ ...row, currency: "SAR" }], autoCategrize: false, bankAccountId: bankId } as never));
    const { rows } = await pool.query(`SELECT id FROM transactions WHERE organization_id = $1 AND description = $2`, [orgId, row.description]);
    return rows[0].id as number;
  }
  const ledgerCash = async (org = orgId) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount),0)::text AS bal FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id JOIN journal_entries je ON je.id = l.journal_entry_id
        WHERE l.organization_id = $1 AND c.liquidity_class = 'cash' AND je.status IN ('posted','reversed')`, [org])).rows[0].bal);
  const entries = async (txnRef: string) =>
    (await pool.query(`SELECT entry_number, status FROM journal_entries WHERE organization_id = $1 AND (entry_number = $2 OR entry_number LIKE $3) ORDER BY id`, [orgId, txnRef, `${txnRef}-%`])).rows;

  /**
   * The reconciliation is asserted over a window that CONTAINS the mirror.
   * `journalEntriesService.reverse` dates every mirror TODAY — the same
   * posture the edit path's reverse-and-repost already has — so the row's own
   * month keeps the original outflow and the cancelling entry lands in the
   * current month: a cross-month shape, not an orphan. Over a window from the
   * row's month to today the residual is unchanged by the whole episode.
   */
  const thisMonth = new Date().toISOString().slice(0, 7);
  const months = (from: string, to: string) => {
    const out: string[] = [];
    let [y, m] = from.split("-").map(Number);
    for (;;) {
      const s = `${y}-${String(m).padStart(2, "0")}`;
      out.push(s);
      if (s >= to) break;
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  };
  const recon = () => inTenant(() => cashService.reconciliation("2026-08", thisMonth, months("2026-08", thisMonth)));
  const ledgerOnly = (r: { summary: { items: Array<{ code: string; amount: number }> } }) =>
    r.summary.items.find((i) => i.code === "ledger_only")?.amount ?? 0;

  it("🔴 a POSTED operating row: delete reverses the entry — cash returns to where it was, the trail stays, reconciliation stays explained", async () => {
    const cashBefore = await ledgerCash();
    const reconBefore = await recon();
    const id = await uploadRow({ date: "2026-08-05", description: "MISIMPORTED RENT 8805", amount: 1200, type: "debit" });
    await inTenant(() => transactionsService.acceptPending([id]));
    expect(await ledgerCash(), "acceptance MOVED cash — the fixture is not vacuous").toBe(cashBefore - 1200);
    expect(await entries(`TXN-${id}`)).toEqual([{ entry_number: `TXN-${id}`, status: "posted" }]);

    await inTenant(() => transactionsService.remove(id));

    expect((await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE id = $1`, [id])).rows[0].n).toBe(0);
    expect(await entries(`TXN-${id}`)).toEqual([
      { entry_number: `TXN-${id}`, status: "reversed" }, // still IN the books, marked
      { entry_number: `TXN-${id}-REV`, status: "posted" }, // its cancelling mirror
    ]);
    expect(await ledgerCash(), "the reversal restores cash exactly").toBe(cashBefore);
    const reconAfter = await recon();
    expect(reconAfter.summary.unexplained).toBe(reconBefore.summary.unexplained);
    expect(ledgerOnly(reconAfter), "no orphan is folded into the ledger-only residual").toBe(ledgerOnly(reconBefore));
    const audit = await pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'transaction' AND entity_id = $2::text ORDER BY created_at`, [orgId, String(id)]);
    expect(audit.rows.map((r) => r.action)).toContain("delete");
  });

  it("a PENDING (never posted) row deletes with no ledger effect at all", async () => {
    const cashBefore = await ledgerCash();
    const id = await uploadRow({ date: "2026-08-06", description: "PENDING JUNK 8806", amount: 33, type: "debit" });
    await inTenant(() => transactionsService.remove(id));
    expect(await ledgerCash()).toBe(cashBefore);
    expect(await entries(`TXN-${id}`)).toEqual([]);
  });

  it("a SETTLED row still refuses (409) and its payment stands", async () => {
    const inv = await inTenant(() =>
      invoicesService.create({ invoiceNumber: "DEL-INV-1", date: "2026-08-01", customerId, items: [{ description: "S", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId),
    );
    await inTenant(() => invoicesService.approve(inv.id, userId));
    const id = await uploadRow({ date: "2026-08-07", description: "INCOMING DEL-INV-1", amount: 115, type: "credit" });
    await inTenant(() => transactionsService.settle(id, { invoiceId: inv.id }, userId));
    await expect(inTenant(() => transactionsService.remove(id))).rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).rows[0].status).toBe("paid");
  });

  it("TENANT ISOLATION: another org cannot delete this org's row, and this org's ledger is untouched by the attempt", async () => {
    const id = await uploadRow({ date: "2026-08-08", description: "MINE 8808", amount: 70, type: "debit" });
    await inTenant(() => transactionsService.acceptPending([id]));
    const cashBefore = await ledgerCash();
    // RLS: the row is invisible from the other tenant; remove finds nothing and deletes nothing.
    await tenant(otherOrgId, otherCompanyId)(() => transactionsService.remove(id));
    expect((await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE id = $1`, [id])).rows[0].n).toBe(1);
    expect(await ledgerCash()).toBe(cashBefore);
    expect(await entries(`TXN-${id}`)).toEqual([{ entry_number: `TXN-${id}`, status: "posted" }]);
  });
});
