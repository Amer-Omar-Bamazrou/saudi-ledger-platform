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
 * ── 🔴 THE ANSWER, MEASURED RATHER THAN ASSUMED ────────────────────────────
 * **No — not at the database level.** `app.current_company_id` is used ONLY as
 * a column DEFAULT (`0004_m4_rls_enforcement.sql` sets it as the default for
 * `company_id` on every business table). It appears in no policy's `USING` or
 * `WITH CHECK` clause. Every `tenant_isolation` policy tests `organization_id`
 * alone.
 *
 * So company separation is enforced **per query, in the repositories** — which
 * is precisely the shape §4 warns about: *enforce invariants at the write
 * boundary, not in one path; per-path enforcement is per-path review, and a new
 * path starts at zero.*
 *
 * ── WHY THIS IS RECORDED RATHER THAN "FIXED" ───────────────────────────────
 * Adding `company_id` to every policy is a schema-wide change with real
 * consequences: org-level reads that legitimately span companies (the operator
 * surface, org settings, anything aggregating across the tenant) would start
 * returning nothing, and the failure mode of getting it wrong is an empty
 * report rather than an error. That is a design decision with an owner, not a
 * patch.
 *
 * What this file does is make the situation **impossible to be wrong about**:
 * it asserts the current behaviour explicitly, so nobody reads "RLS is
 * enforced" and concludes companies are isolated by the database. An assumption
 * nobody has written down is the thing that turns into a finding later.
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

  it("🔴 RLS scopes by ORGANIZATION only — `app.current_company_id` is in NO policy", async () => {
    /**
     * The structural fact, read from the catalog rather than from a migration
     * file, so it stays true as migrations accumulate.
     */
    const policies = await pool.query<{ tablename: string; qual: string | null; withcheck: string | null }>(
      `SELECT tablename, qual::text AS qual, with_check::text AS withcheck
         FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`,
    );
    expect(policies.rowCount, "no tenant_isolation policies found — the check would be vacuous").toBeGreaterThan(20);

    const companyAware = policies.rows.filter(
      (p) => (p.qual ?? "").includes("current_company_id") || (p.withcheck ?? "").includes("current_company_id"),
    );
    // 🔴 Asserting the CURRENT state deliberately. If this ever becomes
    // non-empty, someone has started enforcing company at row level and this
    // file's whole premise — and its warning below — needs revisiting.
    expect(
      companyAware.map((p) => p.tablename),
      "A tenant_isolation policy now references app.current_company_id. That is a " +
        "GOOD change, and it means this test's premise is out of date: re-read the " +
        "header and decide what the new guarantee is before relaxing anything.",
    ).toEqual([]);
  });

  it("🔴 a connection scoped to company A CAN read company B's rows — isolation is per-query, not per-policy", async () => {
    const { db, invoicesTable } = await import("@workspace/db");
    const rows = await inScope(orgId, companyA, () => db.select().from(invoicesTable));
    const numbers = rows.map((r: { invoiceNumber: string }) => r.invoiceNumber).sort();

    /**
     * 🔴 This is the finding, asserted rather than described. A query that does
     * not filter by company sees BOTH companies' books while scoped to one.
     *
     * It is not a vulnerability today: it is not cross-TENANT, the repositories
     * that matter do filter, and no organization has two companies in
     * production because there is no production. It is a **latent** one — the
     * guarantee people assume ("RLS isolates") is narrower than the guarantee
     * that exists, and the gap only becomes visible when a tenant runs two sets
     * of books and a report mixes them.
     */
    expect(
      numbers,
      "If this ever returns only company A's invoice, row-level company scoping " +
        "has been added — update this test and the §5 entry rather than deleting it.",
    ).toEqual(["CCI-A-001", "CCI-B-001"]);
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
  const NO_COMPANY_FILTER = [
    "analytics", "assets", "bankAccounts", "bills", "budgets", "categorize",
    "customers", "employees", "journalEntries", "payments", "payroll",
    "reports", "summary", "transactions", "vendors",
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
