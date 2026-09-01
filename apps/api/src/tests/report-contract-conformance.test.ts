/**
 * REPORT CONTRACT CONFORMANCE — the 14 report endpoints, validated against the
 * generated Zod schemas on REAL ROWS.
 *
 * ── 🔴 WHY THIS EXISTS (contract milestone, batch 1, 2026-09-01) ───────────
 * Four money defects in five weeks came from hand-written response interfaces
 * on report pages (CreditNotes' fields, TrialBalance's `id`, AssetSchedule's
 * NaN, PayrollReport's `month`). Bringing the endpoints into `openapi.yaml`
 * gives the pages generated types — but a schema written from reading the
 * service is itself a hand-written claim until something checks it against
 * what the service RETURNS. "A spec constraint that exists and is not enforced
 * is worse than no constraint" (§3): without this file the spec would be
 * documentation that both the contract and the pages read as coverage.
 *
 * So: every report runs on rows the product's own tables hold (standing rule
 * 2 — validate from real ledger rows), and the response must parse under the
 * generated `Get<Op>Response` schema. Zod objects strip unknown keys silently,
 * so a NEW field the service adds is not a failure here — the pages cannot
 * see it either — but a missing required field, a wrong type, or a null where
 * the schema said string is.
 *
 * ── 🔴 NON-VACUITY ────────────────────────────────────────────────────────
 * A report that validates on an EMPTY result proves only that `[]` matches an
 * array. Each case therefore also asserts the rows are present — the fixture
 * seeds a posted JE, a draft JE, a VAT-touching JE, invoices incl. a credit
 * note and a NULL due date, bills, and a bank movement — so the item schemas
 * are exercised, not skipped. And the instrument is tested: a deliberately
 * broken response must FAIL the same schema (the last case).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import {
  GetTrialBalanceResponse,
  GetIncomeStatementResponse,
  GetBalanceSheetResponse,
  GetCashFlowResponse,
  GetJournalReportResponse,
  GetGeneralLedgerResponse,
  GetAccountStatementResponse,
  GetAccountSummaryResponse,
  GetCustomerLedgerResponse,
  GetOwnerEquityResponse,
  GetArAgingReportResponse,
  GetApAgingReportResponse,
  GetTaxJournalEntriesResponse,
  GetActivityReportResponse,
} from "@workspace/api-zod";
import { auditContext } from "../lib/auditContext";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[report-contract-conformance] no real DATABASE_URL — skipping.");

const SLUG = "report-contract";
const EMAIL = "report-contract@test.local";
const FROM = "2026-01-01";
const TO = "2026-12-31";

type ParseResult = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };

/** Format a Zod failure so the FIRST thing in the message is the path that broke. */
function issues(result: ParseResult): string {
  if (result.success || !result.error) return "";
  return result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
}

describeMaybe("report contract conformance — 14 endpoints against the generated schemas, on real rows", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let cashId = 0;

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

  type Acct = { id: number; name: string };

  /** A system account by code — the org-seed trigger created it with the org. */
  async function acct(code: string): Promise<Acct> {
    const { rows } = await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code]);
    if (!rows[0]) throw new Error(`fixture: no system account ${code} — the org-seed trigger did not run, or the code is wrong`);
    return { id: Number(rows[0].id), name: rows[0].name };
  }

  /** The first seeded account of a type — equity has no system code, only a class. */
  async function byType(type: string): Promise<Acct> {
    const { rows } = await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND type = $2 ORDER BY id LIMIT 1`, [orgId, type]);
    if (!rows[0]) throw new Error(`fixture: no ${type} account was seeded for the org`);
    return { id: Number(rows[0].id), name: rows[0].name };
  }

  async function post(entryNumber: string, date: string, status: string, lines: [Acct, number, number][]) {
    const { rows } = await pool.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
       VALUES ($1,$2,$3,$4,'contract fixture',$5) RETURNING id`,
      [orgId, companyId, entryNumber, date, status],
    );
    for (const [a, debit, credit] of lines) {
      await pool.query(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, description, debit_amount, credit_amount)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7)`,
        [orgId, companyId, rows[0].id, a.id, a.name, debit, credit],
      );
    }
  }

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const U = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    for (const t of ["journal_entry_lines", "journal_entries", "transactions", "bank_accounts", "invoice_items", "invoices", "bill_items", "bills", "customers", "vendors"]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${O}`);
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Contract Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'Contract Co','1010101026') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','RC',' ','viewer',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);

    const cash = await acct("CASH");
    const ar = await acct("AR");
    const ap = await acct("AP");
    const equity = await byType("equity");
    const vatOut = await acct("VAT_OUTPUT");
    const revenue = await acct("SALES");
    const rent = await acct("PURCHASES");
    cashId = cash.id;

    // Posted: capital in; a VAT-bearing sale (income statement + tax journal);
    // a rent accrual (expense side). Draft: must appear in activity and
    // nowhere else.
    await post("RC-1", "2026-03-01", "posted", [[cash, 10000, 0], [equity, 0, 10000]]);
    await post("RC-2", "2026-04-10", "posted", [[ar, 1150, 0], [vatOut, 0, 150], [revenue, 0, 1000]]);
    await post("RC-3", "2026-05-05", "posted", [[rent, 460, 0], [ap, 0, 460]]);
    await post("RC-4", "2026-06-01", "draft", [[cash, 5, 0], [equity, 0, 5]]);

    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar, tax_number) VALUES ($1,'Contract Customer','عميل العقد','310000000000003') RETURNING id`, [orgId])).rows[0].id;
    const vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Contract Vendor') RETURNING id`, [orgId])).rows[0].id;

    await pool.query(
      `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,$3,'RC-INV-1','invoice','2026-04-01','2026-04-30',1000,150,1150,1150,'paid'),
              ($1,$2,$3,'RC-INV-2','invoice','2026-05-01','2026-05-31',2000,300,2300,0,'sent'),
              ($1,$2,$3,'RC-INV-3','invoice','2026-06-01',NULL,300,45,345,0,'sent')`,
      [orgId, companyId, customerId],
    );
    await pool.query(
      `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, original_invoice_id, note_reason, date, subtotal, vat_amount, total, status)
       SELECT $1,$2,$3,'RC-CN-1','credit_note', i.id, 'Returned', '2026-05-15', 100, 15, 115, 'sent'
       FROM invoices i WHERE i.organization_id = $1 AND i.invoice_number = 'RC-INV-2'`,
      [orgId, companyId, customerId],
    );
    await pool.query(
      `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,$3,'RC-BILL-1','2026-05-05','2026-06-05',400,60,460,0,'received'),
              ($1,$2,$3,'RC-BILL-2','2026-06-05',NULL,100,15,115,0,'received')`,
      [orgId, companyId, vendorId],
    );

    const bankId = (
      await pool.query(
        `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name, currency, balance, opening_balance)
         VALUES ($1,$2,'Contract Current','Al Rajhi Bank','SAR',1000,0) RETURNING id`,
        [orgId, companyId],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO transactions (organization_id, company_id, bank_account_id, date, description, amount, type, currency, review_status, kind, category_id)
       VALUES ($1,$2,$3,'2026-04-15','Customer payment',1150,'credit','SAR','accepted','operating',$4),
              ($1,$2,$3,'2026-05-20','Rent',3000,'debit','SAR','accepted','operating',NULL),
              ($1,$2,$3,'2026-05-25','ATM withdrawal',200,'debit','SAR','accepted','transfer',NULL)`,
      [orgId, companyId, bankId, revenue.id],
    );
  });

  afterAll(cleanup);

  /** Validate, and fail with the path list rather than a bare `false`. */
  function conforms(schema: { safeParse: (v: unknown) => ParseResult }, value: unknown, label: string) {
    const r = schema.safeParse(value);
    expect(r.success, `${label} does not conform to its generated schema:\n${issues(r)}`).toBe(true);
  }

  it("GET /reports/trial-balance", async () => {
    const out = await inTenant(() => reportsService.trialBalance(FROM, TO));
    expect(out.accounts.length).toBeGreaterThan(0);
    conforms(GetTrialBalanceResponse, out, "trialBalance");
  });

  it("GET /reports/income-statement", async () => {
    const out = await inTenant(() => reportsService.incomeStatement(FROM, TO));
    expect(out.revenue.length).toBeGreaterThan(0);
    expect(out.expenses.length).toBeGreaterThan(0);
    conforms(GetIncomeStatementResponse, out, "incomeStatement");
  });

  it("GET /reports/balance-sheet", async () => {
    const out = await inTenant(() => reportsService.balanceSheet(TO));
    expect(out.assets.items.length).toBeGreaterThan(0);
    expect(out.liabilities.items.length).toBeGreaterThan(0);
    // The capital posting: equity.items is what the page failed to render.
    expect(out.equity.items.length).toBeGreaterThan(0);
    conforms(GetBalanceSheetResponse, out, "balanceSheet");
  });

  it("GET /reports/cash-flow", async () => {
    const out = await inTenant(() => reportsService.cashFlow(FROM, TO));
    // Accepted operating rows (categorised AND uncategorised) plus a transfer,
    // so every section's item schema is exercised, not skipped.
    expect(out.operating.items.length).toBe(2);
    expect(out.internal.items.length).toBe(1);
    conforms(GetCashFlowResponse, out, "cashFlow");
  });

  it("GET /reports/journal-report", async () => {
    const out = await inTenant(() => reportsService.journalReport(FROM, TO));
    expect(out.entries.length).toBeGreaterThan(0);
    expect(out.entries[0].lines.length).toBeGreaterThan(0);
    conforms(GetJournalReportResponse, out, "journalReport");
  });

  it("GET /reports/general-ledger", async () => {
    const out = await inTenant(() => reportsService.generalLedger(String(cashId), undefined, FROM, TO));
    expect(out.movements.length).toBeGreaterThan(0);
    conforms(GetGeneralLedgerResponse, out, "generalLedger");
  });

  it("GET /reports/account-statement — by id AND by name (the two `account` shapes)", async () => {
    const byId = await inTenant(() => reportsService.accountStatement(String(cashId), undefined, FROM, TO));
    expect(byId.movements.length).toBeGreaterThan(0);
    conforms(GetAccountStatementResponse, byId, "accountStatement(by id)");
    const byName = await inTenant(() => reportsService.accountStatement(undefined, "Cash", FROM, TO));
    conforms(GetAccountStatementResponse, byName, "accountStatement(by name)");
  });

  it("GET /reports/account-summary", async () => {
    const out = await inTenant(() => reportsService.accountSummary(FROM, TO));
    expect(out.accounts.length).toBeGreaterThan(0);
    conforms(GetAccountSummaryResponse, out, "accountSummary");
  });

  it("GET /reports/customer-ledger — including a credit note and a NULL due date", async () => {
    const out = await inTenant(() => reportsService.customerLedger(String(customerId), FROM, TO));
    expect(out.customers.length).toBe(1);
    expect(out.customers[0].invoices.length).toBe(4);
    conforms(GetCustomerLedgerResponse, out, "customerLedger");
    const all = await inTenant(() => reportsService.customerLedger(undefined, FROM, TO));
    conforms(GetCustomerLedgerResponse, all, "customerLedger(all)");
  });

  it("GET /reports/owner-equity", async () => {
    const out = await inTenant(() => reportsService.ownerEquity(FROM, TO));
    expect(out.breakdown.length).toBeGreaterThan(0);
    conforms(GetOwnerEquityResponse, out, "ownerEquity");
  });

  it("GET /reports/ar-aging — including a NULL due date", async () => {
    const out = await inTenant(() => reportsService.arAging());
    expect(out.items.length).toBeGreaterThan(0);
    conforms(GetArAgingReportResponse, out, "arAging");
  });

  it("GET /reports/ap-aging — including a NULL due date", async () => {
    const out = await inTenant(() => reportsService.apAging());
    expect(out.items.length).toBeGreaterThan(0);
    conforms(GetApAgingReportResponse, out, "apAging");
  });

  it("GET /reports/tax-journal-entries", async () => {
    const out = await inTenant(() => reportsService.taxJournalEntries(FROM, TO));
    expect(out.entries.length).toBeGreaterThan(0);
    conforms(GetTaxJournalEntriesResponse, out, "taxJournalEntries");
  });

  it("GET /reports/activity — posted and draft together", async () => {
    const out = await inTenant(() => reportsService.activity(FROM, TO));
    expect(out.hasDraft).toBeGreaterThan(0);
    expect(out.hasPosted).toBeGreaterThan(0);
    conforms(GetActivityReportResponse, out, "activity");
  });

  it("🔴 the instrument is not vacuous — a wrong shape FAILS", async () => {
    const out = await inTenant(() => reportsService.trialBalance(FROM, TO));
    // The exact defect the breadth work found: a page keyed rows on `id`,
    // which the service never sent. Rename the real field and the schema must
    // refuse it.
    const broken = { ...out, accounts: out.accounts.map(({ accountId, ...r }) => ({ ...r, id: accountId })) };
    expect(GetTrialBalanceResponse.safeParse(broken).success).toBe(false);
    expect(GetArAgingReportResponse.safeParse({ buckets: {}, total: "0", items: [] }).success).toBe(false);
  });
});
