/**
 * Audit Tier 3 — credit notes and settlement COMPOSE; cash flow buckets by
 * kind; the platform/ZATCA job-flag split.
 *
 *  - Finding 6: the receivable side is credit-aware everywhere. An invoice
 *    with an approved credit note is settled by `total − credited`; matching
 *    quotes that amount, paying it marks the invoice PAID, and AR aging nets
 *    notes into their originals — so aging always agrees with GL-based
 *    balance-sheet AR, including the refund case (paid then credited shows a
 *    NEGATIVE aged balance rather than vanishing).
 *  - Finding 8: cash flow buckets transfers/settlements as INTERNAL movements,
 *    not operating "Uncategorized".
 *  - Scope-drift fix: `ZATCA_WORKER_ENABLED` gates only the two transport
 *    jobs' schedules; platform jobs (recurring, capture, renewal) always
 *    schedule, and every job stays operator-runnable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { invoicesService } from "../services/invoices.service";
import { reportsService } from "../services/reports.service";
import { buildScheduler, JOB_OUTBOX, JOB_ARCHIVE, JOB_RECURRING, JOB_CAPTURE_PURGE, JOB_RENEWAL } from "../jobs";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[credit-settlement-compose] no real DATABASE_URL — skipping.");

const SLUG = "credit-compose";
const EMAIL = "credit-compose@test.local";

describeMaybe("Audit Tier 3 — credit/settlement composition, cash-flow buckets, job-flag split", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let accountId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bank_accounts WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Compose Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'CC','1010101018','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','CC',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Compose Client') RETURNING id`, [orgId])
    ).rows[0].id;
    accountId = (
      await pool.query(
        `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'CC SAR','ANB') RETURNING id`,
        [orgId, companyId],
      )
    ).rows[0].id;
  });

  afterAll(cleanup);

  async function issue(num: string, unitPrice: number, extra: Record<string, unknown> = {}) {
    const inv = await inTenant(() =>
      invoicesService.create(
        { invoiceNumber: num, date: "2026-07-01", customerId, items: [{ description: "S", quantity: 1, unitPrice, vatRate: 15 }], ...extra },
        userId,
        { autoApprove: false },
      ),
    );
    await inTenant(() => invoicesService.approve(inv.id, userId));
    return inv.id;
  }

  async function uploadRow(row: { date: string; description: string; amount: number; type: "debit" | "credit" }, auto = false) {
    await inTenant(() =>
      transactionsService.upload({ rows: [{ ...row, currency: "SAR" }], autoCategrize: auto, bankAccountId: accountId } as never),
    );
    const { rows } = await pool.query(
      `SELECT id FROM transactions WHERE organization_id = $1 AND description = $2 ORDER BY id DESC LIMIT 1`,
      [orgId, row.description],
    );
    return Number(rows[0].id);
  }

  /** The agreement property: aging total must equal GL-based balance-sheet AR. */
  async function agingAgreesWithBalanceSheet() {
    const [aging, bs] = await Promise.all([
      inTenant(() => reportsService.arAging()),
      inTenant(() => reportsService.balanceSheet("2026-12-31")),
    ]);
    const agingTotal = (aging as { total: number }).total;
    const bsAr = (bs as { assets: { accountsReceivable: number } }).assets.accountsReceivable;
    expect(agingTotal).toBe(bsAr);
    return { aging: aging as { total: number; items: Array<{ invoiceNumber: string; outstanding: number }> }, bsAr };
  }

  it("🔴 a credited invoice settles at total − credited: matching quotes it, paying it marks PAID, aging nets it", async () => {
    const invId = await issue("CC-1", 1000); // 1150 gross
    await issue("CC-CN1", 500, { documentType: "credit_note", originalInvoiceId: invId, noteReason: "partial return" }); // credits 575

    // The customer pays what they actually owe: 1150 − 575 = 575.
    const tx = await uploadRow({ date: "2026-07-10", description: "INCOMING CC-1 FINAL", amount: 575, type: "credit" });
    const pending = await inTenant(() => transactionsService.pendingReview());
    const s = pending.find((p) => p.id === tx)?.suggestion;
    expect(s).toMatchObject({ documentId: invId, matchedBy: "number", partial: false, outstanding: 575 });

    await inTenant(() => transactionsService.settle(tx, { invoiceId: invId }, userId));
    const { rows: [inv] } = await pool.query(`SELECT status, paid_amount::text FROM invoices WHERE id = $1`, [invId]);
    expect(inv.status).toBe("paid"); // 🔴 pre-fix this stayed "sent" forever
    expect(inv.paid_amount).toBe("575.00");

    // Aging nets the note into the original: no +575/−575 pair lingering, and
    // the total agrees with GL AR (both 0 for this org right now).
    const { aging } = await agingAgreesWithBalanceSheet();
    expect(aging.items.find((i) => i.invoiceNumber === "CC-1")).toBeUndefined();
    expect(aging.items.find((i) => i.invoiceNumber === "CC-CN1")).toBeUndefined();
  });

  it("🔴 the refund case: paid in full THEN credited shows a NEGATIVE aged balance — and still agrees with GL", async () => {
    const invId = await issue("CC-2", 200); // 230 gross
    await inTenant(() => invoicesService.pay(invId, { amount: 230 }, userId));
    await issue("CC-CN2", 200, { documentType: "credit_note", originalInvoiceId: invId, noteReason: "full refund" }); // credits 230

    const { aging } = await agingAgreesWithBalanceSheet();
    const row = aging.items.find((i) => i.invoiceNumber === "CC-2");
    expect(row?.outstanding).toBe(-230); // refund owed to the customer — visible, not vanished
  });

  it("overpaying the CREDIT-AWARE outstanding is refused", async () => {
    const invId = await issue("CC-3", 1000); // 1150
    await issue("CC-CN3", 500, { documentType: "credit_note", originalInvoiceId: invId, noteReason: "return" }); // credits 575
    // 1150 would have passed the old total−paid guard; the true outstanding is 575.
    await expect(inTenant(() => invoicesService.pay(invId, { amount: 1150 }, userId))).rejects.toMatchObject({ statusCode: 409 });
    await inTenant(() => invoicesService.pay(invId, { amount: 575 }, userId));
    const { rows: [inv] } = await pool.query(`SELECT status FROM invoices WHERE id = $1`, [invId]);
    expect(inv.status).toBe("paid");
  });

  it("finding 8 — cash flow buckets a transfer as INTERNAL, not operating 'Uncategorized'", async () => {
    const before = await inTenant(() => reportsService.cashFlow("2026-01-01", "2026-12-31"));
    const tx = await uploadRow({ date: "2026-07-20", description: "ATM CASH WITHDRAWAL - ANB KING FAHD RD", amount: 2000, type: "debit" }, true);
    await inTenant(() => transactionsService.acceptPending([tx]));
    const after = await inTenant(() => reportsService.cashFlow("2026-01-01", "2026-12-31"));

    const b = before as { operating: { total: number }; internal: { total: number }; netChange: number };
    const a = after as { operating: { total: number }; internal: { total: number; items: unknown[] }; netChange: number };
    expect(a.operating.total).toBe(b.operating.total); // operating untouched
    expect(a.internal.total).toBe(Math.round((b.internal.total - 2000) * 100) / 100);
    expect(a.netChange).toBe(Math.round((b.netChange - 2000) * 100) / 100); // the bank still moved
  });

  it("assigning a category to a transfer via PATCH resets it to operating — the human's assertion wins", async () => {
    const tx = await uploadRow({ date: "2026-07-21", description: "ATM CASH WITHDRAWAL - ANB OLAYA BR2", amount: 300, type: "debit" }, true);
    const { rows: [before] } = await pool.query(`SELECT kind FROM transactions WHERE id = $1`, [tx]);
    expect(before.kind).toBe("transfer");
    const { rows: [cat] } = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'OFFICE_SUPPLIES'`,
      [orgId],
    );
    await inTenant(() => transactionsService.update(tx, { categoryId: Number(cat.id) } as never));
    const { rows: [after] } = await pool.query(`SELECT kind, category_id FROM transactions WHERE id = $1`, [tx]);
    expect(after.kind).toBe("operating");
    expect(Number(after.category_id)).toBe(Number(cat.id));
  });

  it("flag split — ZATCA transport jobs are registered but unscheduled without the flag; platform jobs schedule", () => {
    // vitest env does not set ZATCA_WORKER_ENABLED ⇒ transport unscheduled.
    const s = buildScheduler();
    const scheduled = s.scheduledNames();
    const all = s.names();
    expect(all).toEqual(expect.arrayContaining([JOB_OUTBOX, JOB_ARCHIVE, JOB_RECURRING, JOB_CAPTURE_PURGE, JOB_RENEWAL]));
    expect(scheduled).not.toContain(JOB_OUTBOX);
    expect(scheduled).not.toContain(JOB_ARCHIVE);
    expect(scheduled).toEqual(expect.arrayContaining([JOB_RECURRING, JOB_CAPTURE_PURGE, JOB_RENEWAL]));
  });
});
