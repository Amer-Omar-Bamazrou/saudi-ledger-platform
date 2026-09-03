/**
 * N1 — COMPANY-SCOPED REPORTS: EXCLUSION, PROVEN THROUGH THE SERVICES.
 *
 * ── Why this file asserts EXCLUSION and not balance (owner, 2026-09-03) ────
 * Before N1, a two-company org's trial balance ADDED BOTH COMPANIES' BOOKS and
 * reported `balanced: true` — truthfully, because two balanced books sum to a
 * balanced book. The report's only self-check returned the identical answer
 * for the correct books and the corrupted ones: §3's "when the CORRECT answer
 * equals the BROKEN one, the test proves nothing", live in the flagship
 * report. So this suite asserts, for every claim, all three of:
 *
 *   1. PRESENCE  — company A's own figure, exactly;
 *   2. ABSENCE   — company B's figure appears nowhere in A's report;
 *   3. MOVEMENT  — the same report under company B's scope shows B's figure,
 *                  so the assertion could not pass vacuously on empty data.
 *
 * ── The fixture is the PRODUCT'S OWN WRITE PATH (standing rule 2) ──────────
 * Both invoices are created and approved through `invoicesService` +
 * `createApproved` — the same path a tenant walks — under each company's own
 * tenant scope. Nothing is inserted directly into the ledger tables.
 *
 * ── The two layers, and the seam between them ──────────────────────────────
 * Company scoping is enforced twice, and the empty-GUC case is where they
 * deliberately DISAGREE (see `repositories/companyScope.ts` and migration
 * 0065):
 *
 *   RLS (0065)          company GUC set → that company's rows;
 *                       GUC empty → org-wide (the findings scheduler's
 *                       deliberate semantic — it opens org-wide connections).
 *   report predicates   company GUC set → that company's rows;
 *                       GUC empty → NOTHING, so a misconfigured request gets
 *                       an EMPTY report — visible — never a doubled one that
 *                       reads as an answer.
 *
 * Both semantics are pinned below, each with the reason it is what it is.
 *
 * Needs a real database; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool, db, invoicesTable } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { reportsService } from "../services/reports.service";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[company-scoped-reports] no real DATABASE_URL — skipping.");

const SLUG = "n1-company-scope";
const EMAIL = "n1-scope@test.local";

// Deliberately 9× apart so a mixed figure cannot be mistaken for either
// company's own (1,150 vs 10,350 vs the corrupted 11,500).
const DATE = "2026-07-10";
const RANGE = { from: "2026-07-01", to: "2026-07-31" };
const A = { subtotal: 1000, vat: 150, total: 1150 };
const B = { subtotal: 9000, vat: 1350, total: 10350 };

describeMaybe("N1 — company A's reports EXCLUDE company B's books", () => {
  let orgId = "";
  let companyA = "";
  let companyB = "";
  let userId = 0;
  let customerId = 0;

  /** Run `fn` scoped to one company — the shape every HTTP request has. */
  async function inCompany<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.77" }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  /** Run `fn` org-wide — the findings scheduler's shape (no company GUC). */
  async function orgWide<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, role: "authenticated" });
    try {
      const out = await conn.run(fn);
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  // Cleanup keyed on the slug/email, never in-memory ids (self-healing after
  // an aborted run — the credit-notes suite's lesson).
  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('N1 Scope Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyA = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'N1 Co A','1010202020','399999999900003') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    companyB = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'N1 Co B','1010303030','399999999911103') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','N1 Approver',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(
        `INSERT INTO customers (organization_id, name, name_ar, tax_number) VALUES ($1,'Shared Client','عميل مشترك','300000000000003') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;

    // One issued invoice per company, through the product's own write path.
    await inCompany(companyA, () =>
      createApproved(invoicesService, {
        invoiceNumber: "N1-A-001",
        date: DATE,
        dueDate: DATE,
        customerId,
        items: [{ description: "Widgets A", quantity: 10, unitPrice: 100, vatRate: 15 }],
      }, userId),
    );
    await inCompany(companyB, () =>
      createApproved(invoicesService, {
        invoiceNumber: "N1-B-001",
        date: DATE,
        dueDate: DATE,
        customerId,
        items: [{ description: "Widgets B", quantity: 90, unitPrice: 100, vatRate: 15 }],
      }, userId),
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  it("🔴 trial balance: A's figures exactly, B's NOWHERE — and B's scope shows B's, so the figure MOVES", async () => {
    const tbA = await inCompany(companyA, () => reportsService.trialBalance(RANGE.from, RANGE.to));
    const tbB = await inCompany(companyB, () => reportsService.trialBalance(RANGE.from, RANGE.to));

    // PRESENCE — A's AR is A's total, to the halala.
    const arA = tbA.accounts.find((a) => a.name === "Accounts Receivable");
    expect(arA?.debit).toBe(A.total);

    // ABSENCE — no figure from B's books, and no SUM of the two, appears in
    // any of A's rows. 11,500 is the corrupted value this test exists to bury.
    const allFiguresA = tbA.accounts.flatMap((a) => [a.debit, a.credit, a.balance]);
    for (const corrupted of [B.subtotal, B.vat, B.total, A.total + B.total, A.subtotal + B.subtotal]) {
      expect(allFiguresA, `company B's figure ${corrupted} leaked into A's trial balance`).not.toContain(corrupted);
    }

    // MOVEMENT — the same call under B's scope answers with B's books, so the
    // absence above cannot be an artifact of an empty fixture.
    const arB = tbB.accounts.find((a) => a.name === "Accounts Receivable");
    expect(arB?.debit).toBe(B.total);

    // Both are individually balanced — which is exactly why `balanced` could
    // never have caught the pre-N1 merge, and why this suite asserts figures.
    expect(tbA.balanced).toBe(true);
    expect(tbB.balanced).toBe(true);
    expect(tbA.totalDebit).not.toBe(tbB.totalDebit);
  });

  it("income statement: A's revenue is A's subtotal, not the org's", async () => {
    const isA = await inCompany(companyA, () => reportsService.incomeStatement(RANGE.from, RANGE.to));
    expect(isA.totalRevenue).toBe(A.subtotal);
    expect(isA.totalRevenue).not.toBe(A.subtotal + B.subtotal);
  });

  it("🔴 VAT return: A's output VAT is 150, not the org's 1,500 — the statutory figure", async () => {
    const vatA = await inCompany(companyA, () => reportsService.vatReturn(RANGE.from, RANGE.to));
    const vatB = await inCompany(companyB, () => reportsService.vatReturn(RANGE.from, RANGE.to));
    const flatA = JSON.stringify(vatA);
    expect(flatA).toContain("150");
    expect(flatA, "company B's output VAT leaked into A's VAT return").not.toContain("1350");
    expect(JSON.stringify(vatB)).toContain("1350");
  });

  it("balance sheet: A's AR is A's receivable only", async () => {
    const bsA = await inCompany(companyA, () => reportsService.balanceSheet(RANGE.to));
    const flat = JSON.stringify(bsA);
    expect(flat).toContain(String(A.total));
    expect(flat, "B's receivable leaked into A's balance sheet").not.toContain(String(A.total + B.total));
  });

  it("🔴 the DB backstop: an UNFILTERED select under A's scope returns only A's rows", async () => {
    // No repository, no predicate — RLS alone. This is the row-level guarantee
    // migration 0065 added, the one the old cross-company test proved absent.
    const rows = await inCompany(companyA, () => db.select().from(invoicesTable));
    expect(rows.map((r) => r.invoiceNumber)).toEqual(["N1-A-001"]);
  });

  it("the org-wide arm: a connection with NO company GUC reads both — the findings scheduler's semantic, pinned deliberately", async () => {
    // `findings.schedule.service.ts` opens org-wide tenant connections on
    // purpose. If this assertion ever fails with only one company's rows, the
    // empty-GUC arm has been tightened and that job silently reads nothing —
    // decide that on purpose, not by drift.
    const rows = await orgWide(() => db.select().from(invoicesTable));
    expect(rows.map((r) => r.invoiceNumber).sort()).toEqual(["N1-A-001", "N1-B-001"]);
  });

  it("🔴 a report under an org-wide scope is EMPTY, never doubled — the two layers disagree loudly", async () => {
    // The repositories' own predicate matches nothing when the company GUC is
    // empty. So the failure mode of a request that forgot its company is an
    // empty report someone complains about — not a merged one that reads as an
    // answer. If this returns rows, the repo predicate has been weakened to
    // "GUC empty → everything", which recreates the pre-N1 merge for exactly
    // the misconfigured caller most likely to hit it.
    const tb = await orgWide(() => reportsService.trialBalance(RANGE.from, RANGE.to));
    expect(tb.accounts).toEqual([]);
  });
});
