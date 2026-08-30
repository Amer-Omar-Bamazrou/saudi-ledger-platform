/**
 * Audit Tier 2 — the acceptance guarantee, and invariants at the write boundary.
 *
 *  - Finding 3: a Categorize run must NEVER touch a row past the acceptance
 *    boundary (accepted, transfer, settlement) — even by explicit id. A human's
 *    recorded acceptance covers the numbers AS ACCEPTED; the engine rewriting
 *    them afterwards means the acceptance certifies figures that no longer
 *    exist.
 *  - Finding 4: "Z/E/O means no VAT" lives in the DATABASE (CHECK, migration
 *    0034), not in one service path. Three paths used to violate it; every
 *    violating row moved the VAT reconciliation by an amount its own treatment
 *    said could not exist. NULL treatment (honest-unknown) may carry
 *    user-asserted VAT by design.
 *  - Finding 5/6: a settlement row is the bank-side record of a posted
 *    payment — not deletable, tax facts not editable. Both directions of the
 *    settlement-link CHECK are pinned.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { categorizeService } from "../services/categorize.service";
import { invoicesService } from "../services/invoices.service";
import { summaryService } from "../services/summary.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[write-boundary-invariants] no real DATABASE_URL — skipping.");

const SLUG = "write-boundary";
const EMAIL = "write-boundary@test.local";

describeMaybe("Audit Tier 2 — acceptance guarantee + write-boundary invariants", () => {
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
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('WB Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'WB','1010101017','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','WB',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'WB Client') RETURNING id`, [orgId])
    ).rows[0].id;
    accountId = (
      await pool.query(
        `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'WB SAR','SNB') RETURNING id`,
        [orgId, companyId],
      )
    ).rows[0].id;
  });

  afterAll(cleanup);

  async function uploadRow(row: { date: string; description: string; amount: number; type: "debit" | "credit" }, auto = true) {
    await inTenant(() =>
      transactionsService.upload({ rows: [{ ...row, currency: "SAR" }], autoCategrize: auto, bankAccountId: accountId } as never),
    );
    const { rows } = await pool.query(
      `SELECT id FROM transactions WHERE organization_id = $1 AND description = $2 ORDER BY id DESC LIMIT 1`,
      [orgId, row.description],
    );
    return Number(rows[0].id);
  }

  // ── Finding 3: the acceptance boundary ────────────────────────────────────

  it("🔴 a categorize run cannot touch an ACCEPTED row — even named by explicit id", async () => {
    const id = await uploadRow({ date: "2026-07-01", description: "WB ACCEPTED UNCATEGORIZED 111", amount: 500, type: "debit" }, false);
    await inTenant(() => transactionsService.acceptPending([id]));
    const before = await inTenant(() => summaryService.getVat({ dateFrom: "2026-01-01", dateTo: "2026-12-31" }));

    const run = await inTenant(() => categorizeService.run({ transactionIds: [id], overrideExisting: true } as never));
    expect((run as { categorized: number }).categorized).toBe(0);

    const { rows: [after] } = await pool.query(`SELECT category_id, vat_amount, kind FROM transactions WHERE id = $1`, [id]);
    expect(after.category_id).toBeNull();
    expect(after.vat_amount).toBeNull();
    expect(after.kind).toBe("operating");
    const vatAfter = await inTenant(() => summaryService.getVat({ dateFrom: "2026-01-01", dateTo: "2026-12-31" }));
    expect(vatAfter).toEqual(before); // no tax figure moved without a human
  });

  it("a bulk categorize run skips accepted rows and processes pending ones", async () => {
    const pending = await uploadRow({ date: "2026-07-02", description: "SADAD PAYMENT - STC 0100200300", amount: 230, type: "debit" }, false);
    const run = await inTenant(() => categorizeService.run({} as never));
    const { rows: [row] } = await pool.query(`SELECT category_id, tax_treatment, vat_amount::text FROM transactions WHERE id = $1`, [pending]);
    expect(row.category_id).not.toBeNull(); // the pending row was categorized (S, VAT extracted)
    expect(row.tax_treatment).toBe("S");
    expect(row.vat_amount).toBe("30.00");
    expect((run as { categorized: number }).categorized).toBeGreaterThanOrEqual(1);
  });

  it("a transfer row is untouchable by categorize even by explicit id", async () => {
    const id = await uploadRow({ date: "2026-07-03", description: "ATM CASH WITHDRAWAL - ANB OLAYA", amount: 900, type: "debit" });
    const { rows: [k] } = await pool.query(`SELECT kind FROM transactions WHERE id = $1`, [id]);
    expect(k.kind).toBe("transfer");
    const run = await inTenant(() => categorizeService.run({ transactionIds: [id] } as never));
    expect((run as { categorized: number }).categorized).toBe(0);
    const { rows: [after] } = await pool.query(`SELECT kind, category_id FROM transactions WHERE id = $1`, [id]);
    expect(after.kind).toBe("transfer");
    expect(after.category_id).toBeNull();
  });

  // ── Finding 4: treatment/VAT at the write boundary ────────────────────────

  it("🔴 the DB itself refuses a Z/E/O row carrying VAT (CHECK 0034) — the invariant survives a future code path", async () => {
    await expect(
      pool.query(
        `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, tax_treatment, vat_amount, review_status)
         VALUES ($1,$2,'2026-07-04','WB ILLEGAL Z WITH VAT', 115, 'debit', 'Z', 15, 'accepted')`,
        [orgId, companyId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("upload: CSV-supplied VAT is dropped when the resolved treatment is Z/E/O — the classification wins", async () => {
    // ZAKAT_PAYMENT resolves to 'O'; the CSV claims 100 of VAT. Pre-fix the row
    // persisted treatment='O' + 100 VAT and moved the reconciliation.
    await inTenant(() =>
      transactionsService.upload({
        rows: [{ date: "2026-07-05", description: "ZAKAT PAYMENT ZATCA 2026", amount: 5000, currency: "SAR", type: "debit", vatAmount: 100, vatRate: 15 }],
        autoCategrize: true,
        bankAccountId: accountId,
      } as never),
    );
    const { rows: [row] } = await pool.query(
      `SELECT tax_treatment, vat_amount FROM transactions WHERE organization_id = $1 AND description LIKE 'ZAKAT PAYMENT%'`,
      [orgId],
    );
    expect(row.tax_treatment).toBe("O");
    expect(row.vat_amount).toBeNull();
  });

  it("PATCH: vatAmount against a non-'S' treatment is a 400; null treatment may carry user-asserted VAT", async () => {
    const id = await uploadRow({ date: "2026-07-06", description: "WB PLAIN ROW 222", amount: 115, type: "debit" }, false);
    await inTenant(() => transactionsService.update(id, { taxTreatment: "Z" } as never));
    await expect(inTenant(() => transactionsService.update(id, { vatAmount: 15 } as never))).rejects.toMatchObject({ statusCode: 400 });
    // Honest-unknown still accepts asserted VAT (manual-entry design):
    await inTenant(() => transactionsService.update(id, { taxTreatment: null, vatAmount: 15 } as never));
    const { rows: [row] } = await pool.query(`SELECT tax_treatment, vat_amount::text FROM transactions WHERE id = $1`, [id]);
    expect(row.tax_treatment).toBeNull();
    expect(row.vat_amount).toBe("15.00");
  });

  it("a notes-only PATCH does not claim the human-override marker", async () => {
    const id = await uploadRow({ date: "2026-07-07", description: "WB NOTES ONLY 333", amount: 80, type: "debit" }, false);
    await inTenant(() => transactionsService.update(id, { notes: "checked against receipt" } as never));
    const { rows: [row] } = await pool.query(`SELECT is_manually_overridden, notes FROM transactions WHERE id = $1`, [id]);
    expect(row.notes).toBe("checked against receipt");
    expect(row.is_manually_overridden).toBe(false);
  });

  // ── Findings 5/6: settlement integrity ────────────────────────────────────

  it("🔴 a settlement row cannot be deleted, and its tax facts cannot be edited", async () => {
    const inv = await inTenant(() =>
      invoicesService.create(
        { invoiceNumber: "WB-INV-1", date: "2026-07-08", customerId, items: [{ description: "S", quantity: 1, unitPrice: 100, vatRate: 15 }] },
        userId),
    );
    await inTenant(() => invoicesService.approve(inv.id, userId));
    const txId = await uploadRow({ date: "2026-07-09", description: "INCOMING WB-INV-1 SETTLEMENT", amount: 115, type: "credit" }, false);
    await inTenant(() => transactionsService.settle(txId, { invoiceId: inv.id }, userId));

    await expect(inTenant(() => transactionsService.remove(txId))).rejects.toMatchObject({ statusCode: 409 });
    await expect(inTenant(() => transactionsService.update(txId, { vatAmount: 10 } as never))).rejects.toMatchObject({ statusCode: 409 });
    await expect(inTenant(() => transactionsService.update(txId, { categoryId: null } as never))).rejects.toMatchObject({ statusCode: 409 });
    // Notes stay editable — the guard is about tax facts, not annotations.
    await inTenant(() => transactionsService.update(txId, { notes: "matched by bank ref" } as never));
  });

  it("the DB ties settlement links to the kind, both directions (CHECK 0034)", async () => {
    // A link on an operating row:
    const { rows: [inv] } = await pool.query(`SELECT id FROM invoices WHERE organization_id = $1 LIMIT 1`, [orgId]);
    await expect(
      pool.query(
        `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, kind, settles_invoice_id, review_status)
         VALUES ($1,$2,'2026-07-10','WB ILLEGAL LINK', 10, 'credit', 'operating', $3, 'accepted')`,
        [orgId, companyId, inv.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // A settlement naming no document:
    await expect(
      pool.query(
        `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, kind, review_status)
         VALUES ($1,$2,'2026-07-10','WB ILLEGAL SETTLEMENT', 10, 'credit', 'settlement', 'accepted')`,
        [orgId, companyId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
