/**
 * SAME-ORG CROSS-COMPANY ISOLATION — the second unaudited gap in `CLAUDE.md` §5.
 *
 * ── THE QUESTION ───────────────────────────────────────────────────────────
 * An `organization` is the tenant and the unit of RLS. A `company` is the
 * reporting entity inside it — its own document sequences, its own fiscal
 * calendar, its own period locks. Two companies in one organization are
 * SEPARATE SETS OF BOOKS.
 *
 * RLS was audited for cross-ORGANIZATION isolation and is solid. Nobody had
 * asked the narrower question: **does anything stop a request scoped to company
 * A from reading company B's rows, when both belong to the same tenant?**
 *
 * ── 🔴 THE ANSWER — CHANGED BY N1 (2026-09-03; owner decision) ────────
 * Until N1, **nothing** stopped it at the database: `app.current_company_id`
 * was only a column DEFAULT, every `tenant_isolation` policy tested
 * `organization_id` alone, and fifteen repositories queried company-scoped
 * tables with no company filter — so a two-company org's trial balance, GL and
 * VAT return ADDED BOTH SETS OF BOOKS under a green `balanced: true`. Record:
 * `docs/history/erpnext-comparison-2026-09-03.md` §1; this file's git history
 * holds the pre-N1 assertions.
 *
 * Migration 0065 added the company arm to every tenant_isolation policy on a
 * table carrying `company_id`:
 *
 *   company GUC set   → that company's rows (plus `company_id IS NULL` rows on
 *                       the two NULLABLE tables, `findings` and `ai_usage` —
 *                       org-level facts a company-scoped page must still see);
 *   company GUC empty → org-wide, deliberately: `findings.schedule.service.ts`
 *                       opens org-wide tenant connections on purpose. The
 *                       report repositories' own predicates match NOTHING in
 *                       that state, so a misconfigured request yields an EMPTY
 *                       report, never a doubled one
 *                       (`company-scoped-reports.test.ts` pins both arms).
 *
 * This file asserts the NEW guarantee structurally — from `pg_policies`, so it
 * holds as migrations accumulate — and keeps the shrink-only list of
 * repositories that still rely on RLS alone for company separation.
 *
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3169";
process.env.SESSION_SECRET ??= "cross-company-secret-0123456789abcdef";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "cross-company-isolation";

async function inScope<T>(orgId: string, companyId: string, fn: () => Promise<T>): Promise<T> {
  const { beginTenantConnection } = await import("@workspace/db");
  const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
  try {
    const out = await conn.run(fn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  }
}

describeMaybe("same-org cross-company isolation", () => {
  let orgId = "";
  let companyA = "";
  let companyB = "";

  const wipe = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(
      `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`,
    );
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await wipe();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status)
         VALUES ('Two Company Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    companyA = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Company A') RETURNING id`, [orgId])
    ).rows[0].id;
    companyB = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Company B') RETURNING id`, [orgId])
    ).rows[0].id;
    const customer = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Shared Customer') RETURNING id`, [orgId])
    ).rows[0].id;

    // One invoice in each company's books. Same tenant, different entities.
    await pool.query(
      `INSERT INTO invoices
         (organization_id, company_id, customer_id, invoice_number, document_type,
          date, subtotal, vat_amount, total, status)
       VALUES
         ($1,$2,$4,'CCI-A-001','invoice','2026-07-01',1000,150,1150,'sent'),
         ($1,$3,$4,'CCI-B-001','invoice','2026-07-01',9000,1350,10350,'sent')`,
      [orgId, companyA, companyB, customer],
    );
  });

  afterAll(wipe);

  it("the fixture landed — two companies, one invoice each", async () => {
    const r = await pool.query(
      `SELECT company_id, count(*)::int n FROM invoices WHERE organization_id = $1 GROUP BY company_id`,
      [orgId],
    );
    expect(r.rowCount).toBe(2);
    expect(r.rows.every((x) => x.n === 1)).toBe(true);
  });

  it("🔴 N1: EVERY tenant_isolation policy on a company_id table references app.current_company_id — both directions", async () => {
    /**
     * Read from the catalog, not from migration 0065's text, so it stays true
     * as migrations accumulate — and asserted in BOTH directions (the
     * map-replaces-a-map rule): every company_id table's policy carries the
     * arm, and the arm appears on no table without the column.
     */
    const rows = await pool.query<{ tablename: string; qual: string | null; has_company: boolean; company_nullable: boolean }>(
      `SELECT p.tablename, p.qual::text AS qual,
              EXISTS (SELECT 1 FROM information_schema.columns c
                       WHERE c.table_schema = 'public' AND c.table_name = p.tablename
                         AND c.column_name = 'company_id') AS has_company,
              COALESCE((SELECT c.is_nullable = 'YES' FROM information_schema.columns c
                         WHERE c.table_schema = 'public' AND c.table_name = p.tablename
                           AND c.column_name = 'company_id'), false) AS company_nullable
         FROM pg_policies p WHERE p.schemaname = 'public' AND p.policyname = 'tenant_isolation'`,
    );
    expect(rows.rowCount, "no tenant_isolation policies found — the check would be vacuous").toBeGreaterThan(20);

    const withColumn = rows.rows.filter((r) => r.has_company);
    expect(
      withColumn.length,
      "fewer than 30 company_id tables carry a tenant_isolation policy — the inventory read is broken, not the schema",
    ).toBeGreaterThanOrEqual(30);

    // Direction 1: every company_id table's policy carries the company arm.
    // 🔴 This is what closes 0065 against a table created AFTER it: a new
    // company-scoped table whose author writes the old org-only policy fails
    // HERE, by name.
    const missingArm = withColumn.filter((r) => !(r.qual ?? "").includes("current_company_id")).map((r) => r.tablename);
    expect(
      missingArm,
      "These company_id tables have a tenant_isolation policy WITHOUT the company arm.\n" +
        "A new company-scoped table must scope rows to app.current_company_id — see\n" +
        "migration 0065_n1_company_row_scoping.sql for the exact clause (and the\n" +
        "nullable variant for tables whose company_id can be NULL).",
    ).toEqual([]);

    // Direction 2: no policy references the GUC on a table without the column.
    const armWithoutColumn = rows.rows
      .filter((r) => !r.has_company && (r.qual ?? "").includes("current_company_id"))
      .map((r) => r.tablename);
    expect(armWithoutColumn).toEqual([]);

    // And the nullable tables keep their org-level rows readable: their arm
    // must carry `company_id IS NULL` (findings / ai_usage would otherwise
    // render an empty Findings page under every company-scoped request).
    const nullableMissingNullArm = withColumn
      .filter((r) => r.company_nullable && !(r.qual ?? "").includes("company_id IS NULL"))
      .map((r) => r.tablename);
    expect(nullableMissingNullArm).toEqual([]);
  });

  it("🔴 N1: a connection scoped to company A can NOT read company B's rows — the row-level backstop", async () => {
    const { db, invoicesTable } = await import("@workspace/db");
    const rows = await inScope(orgId, companyA, () => db.select().from(invoicesTable));
    const numbers = rows.map((r: { invoiceNumber: string }) => r.invoiceNumber).sort();

    /**
     * The exact query that proved the gap pre-N1 (it returned BOTH invoices),
     * now asserting the backstop: no repository filter, no service, just an
     * unfiltered select under a company scope. The repositories that never
     * wrote a company filter (the shrink-only list below) are covered by THIS
     * guarantee — which is why the list may only shrink and never grow.
     */
    expect(numbers).toEqual(["CCI-A-001"]);
  });

  it("a query that DOES filter by company is correctly scoped — the per-query enforcement works", async () => {
    const { db, invoicesTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const rows = await inScope(orgId, companyA, () =>
      db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyA)),
    );
    // Paired with the assertion above: the mechanism that exists does work.
    // What is missing is the backstop when a query forgets.
    expect(rows.map((r: { invoiceNumber: string }) => r.invoiceNumber)).toEqual(["CCI-A-001"]);
  });

  /**
   * 🔴 THE EXPOSURE, MEASURED — and this is the part that matters.
   *
   * With no row-level company scoping, separation depends entirely on each
   * repository remembering to filter. So: which repositories query
   * company-scoped tables and never mention company at all?
   *
   * Measured 2026-08-31 — FIFTEEN, and they are not peripheral:
   *
   *   reports          transactions, invoices, invoice_items, bills,
   *                    bill_items, journal_entries, journal_entry_lines
   *   analytics        journal_entries, journal_entry_lines, transactions,
   *                    invoices, bills
   *   journalEntries · bills · transactions · payments · payroll · assets ·
   *   budgets · bankAccounts · employees · categorize · summary · customers ·
   *   vendors
   *
   * 🔴 **For an organization with two companies, that means the trial balance,
   * the general ledger, the income statement, the balance sheet, the VAT
   * return and analytics ADD BOTH COMPANIES' BOOKS TOGETHER and present the
   * result as one entity's figures.** Not a leak between tenants — something
   * arguably worse for an accounting product: a confident, wrong, auditable
   * number, with nothing on the page saying it spans two sets of books.
   *
   * Multi-company is a SHIPPED feature (M11). This is the narrower-claim shape
   * at the level of a whole capability: the model supports two companies and
   * the reporting does not separate them.
   *
   * The list is pinned so it can only SHRINK. It is not a to-do disguised as a
   * test — it is the honest size of the gap, and a new repository joining it
   * should be a deliberate act, not an accident.
   */
  // N1 (2026-09-03): `reports`, `analytics` and `summary` LEFT this list —
  // their shared condition builders now carry `companyScoped()` explicitly.
  // The rest rely on the 0065 row-level backstop, asserted above; they remain
  // listed because a repository-level predicate is still the better place for
  // the filter to be VISIBLE, and each departure should be a deliberate edit.
  const NO_COMPANY_FILTER = [
    "assets", "bankAccounts", "bills", "budgets", "categorize",
    "customers", "employees", "journalEntries", "payments", "payroll",
    "transactions", "vendors",
  ];

  it("🔴 the set of company-blind repositories only SHRINKS", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(HERE, "../repositories");
    const blind: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".repository.ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      const touchesCompanyScoped = /\b(invoices|bills|journalEntries|transactions|payroll|fixedAssets|budgets|bankAccounts|employees|invoiceItems|billItems|journalEntryLines|invoicePayments|billPayments|depreciationEntries|payrollRuns|payrollItems)Table\b/.test(src);
      if (!touchesCompanyScoped) continue;
      if (!/companyId|company_id/.test(src)) blind.push(f.replace(".repository.ts", ""));
    }
    const added = blind.filter((r) => !NO_COMPANY_FILTER.includes(r)).sort();
    expect(
      added,
      "A NEW repository queries company-scoped tables without filtering by company.\n" +
        "In a two-company organization its figures span both sets of books.\n" +
        "Either filter by company, or add it to NO_COMPANY_FILTER deliberately.",
    ).toEqual([]);
    // And the list must not rot: an entry that has since been fixed leaves.
    const stale = NO_COMPANY_FILTER.filter((r) => !blind.includes(r)).sort();
    expect(stale, "NO_COMPANY_FILTER names repositories that now DO filter — remove them").toEqual([]);
  });

  it("🔴 the DEFAULT still writes the scoped company — a new row lands in the right books", async () => {
    const { db, invoicesTable } = await import("@workspace/db");
    await inScope(orgId, companyB, async () => {
      await db.insert(invoicesTable).values({
        invoiceNumber: "CCI-B-002",
        documentType: "invoice",
        date: "2026-07-02",
        subtotal: "100",
        vatAmount: "15",
        total: "115",
        status: "draft",
      } as never);
    });
    const r = await pool.query(
      `SELECT company_id FROM invoices WHERE organization_id = $1 AND invoice_number = 'CCI-B-002'`,
      [orgId],
    );
    // The GUC's real job: it defaults the column on write, which is why rows
    // land correctly even though nothing enforces reads.
    expect(r.rows[0]?.company_id).toBe(companyB);
    await pool.query(`DELETE FROM invoices WHERE organization_id = $1 AND invoice_number = 'CCI-B-002'`, [orgId]);
  });
});
