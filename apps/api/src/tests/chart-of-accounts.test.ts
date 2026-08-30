/**
 * M13 — chart of accounts and GL classification.
 *
 * THE ACCEPTANCE TEST: revenue appears as revenue.
 *
 * Before M13, `postJournalEntry` wrote `account_id = NULL` and no automated
 * caller supplied one, so the income statement's `cat?.type ?? "expense"` filed
 * every invoice's Sales Revenue CREDIT as a NEGATIVE EXPENSE. Revenue read as
 * zero, expenses were understated by the same amount, and **net profit came out
 * right** — which is precisely why it survived to production.
 *
 * Written to the M10 zero-movement standard: real ledger rows through the real
 * approval path and the real report services, never fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool, SYSTEM_CHART_OF_ACCOUNTS } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { reportsService } from "../services/reports.service";
import { postJournalEntry, AccountResolutionError } from "../services/accounting/glPosting";
import { journalEntriesService } from "../services/journalEntries.service";
import { summaryService } from "../services/summary.service";
import { periodLocksService } from "../services/periodLocks.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[chart-of-accounts] no real DATABASE_URL — skipping.");

const SLUG = "m13-coa";
const EMAIL = "m13-coa@test.local";

describeMaybe("M13 — chart of accounts + GL classification", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.13" }, fn),
      );
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
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM period_locks WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('CoA Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'CoA Co','1010101010','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','CoA',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'Client','عميل') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(cleanup);

  /** 1,000 net + 15% VAT = 1,150 gross. */
  async function issueInvoice(n: number, unitPrice = 1000) {
    const inv = await inTenant(() =>
      invoicesService.create(
        {
          invoiceNumber: `COA-${n}`,
          date: "2026-06-15",
          customerId,
          items: [{ description: "Service", quantity: 1, unitPrice, vatRate: 15 }],
        },
        userId),
    );
    await inTenant(() => invoicesService.approve(inv.id, userId));
    return inv.id;
  }

  // ── The chart itself ─────────────────────────────────────────────────────

  describe("the chart of accounts exists and is protected", () => {
    it("🔴 a brand-new organization is seeded with the system chart AUTOMATICALLY", async () => {
      // The DB trigger, not application code. Before M13 `categories` was empty
      // in live databases and nothing ever created a row — so a tenant could not
      // post at all once resolution became mandatory. This org was created with
      // a plain INSERT in beforeAll, exactly like the seed and the test fixtures.
      const { rows } = await pool.query(
        `SELECT system_code, type FROM categories WHERE organization_id = $1 AND is_system ORDER BY system_code`,
        [orgId],
      );
      expect(rows).toHaveLength(SYSTEM_CHART_OF_ACCOUNTS.length);
      expect(rows.map((r) => r.system_code)).toEqual(
        [...SYSTEM_CHART_OF_ACCOUNTS].map((a) => a.code).sort(),
      );
    });

    it("the SQL template and the TypeScript definition agree", async () => {
      // They are necessarily duplicated — SQL cannot call TypeScript — so the
      // duplication is pinned rather than trusted. A drift here means the
      // migration and the code disagree about what an account IS.
      // M15 added 25 DEFAULT categories (is_system = false) to the same
      // template so the categorization engine has seeded rows to resolve
      // against. This test's claim is about the SYSTEM tier — the protected 11
      // the posting path depends on — so it filters to it. The defaults have
      // their own agreement test (categorization-m15.test.ts §1).
      const { rows } = await pool.query(
        `SELECT code, name, name_ar, type FROM system_account_templates WHERE is_system ORDER BY code`,
      );
      const ts = [...SYSTEM_CHART_OF_ACCOUNTS].sort((a, b) => a.code.localeCompare(b.code));
      expect(rows).toHaveLength(ts.length);
      rows.forEach((r, i) => {
        expect({ code: r.code, name: r.name, nameAr: r.name_ar, type: r.type }).toEqual({
          code: ts[i].code,
          name: ts[i].name,
          nameAr: ts[i].nameAr,
          type: ts[i].type,
        });
      });
    });

    it("the app role cannot delete or retype a system account, but CAN rename it", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
        await client.query("SET LOCAL ROLE authenticated");

        const attempt = async (sql: string) => {
          await client.query("SAVEPOINT sp");
          try {
            const r = await client.query(sql);
            await client.query("ROLLBACK TO SAVEPOINT sp");
            return { blocked: false, rows: r.rowCount };
          } catch {
            await client.query("ROLLBACK TO SAVEPOINT sp");
            return { blocked: true, rows: 0 };
          }
        };

        // The posting path resolves by code and every statement buckets by type.
        expect((await attempt(`DELETE FROM categories WHERE system_code='SALES'`)).blocked).toBe(true);
        expect((await attempt(`UPDATE categories SET type='expense' WHERE system_code='SALES'`)).blocked).toBe(true);
        expect((await attempt(`UPDATE categories SET system_code='X' WHERE system_code='SALES'`)).blocked).toBe(true);

        // 🔴 But the NAME is a label, not the identity — renaming and translating
        // must stay possible, which is the whole reason resolution is by code.
        const renamed = await attempt(`UPDATE categories SET name='Revenue from Sales' WHERE system_code='SALES'`);
        expect(renamed.blocked).toBe(false);
        expect(renamed.rows).toBe(1);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    });
  });

  // ── The acceptance test ──────────────────────────────────────────────────

  describe("THE ACCEPTANCE TEST — revenue appears as revenue", () => {
    let invoiceId = 0;

    beforeAll(async () => {
      invoiceId = await issueInvoice(1);
    });

    it("🔴 posts every GL line with a resolved account — never a NULL", async () => {
      const { rows } = await pool.query(
        `SELECT l.account_name, l.account_id, c.system_code, c.type
           FROM journal_entry_lines l
           LEFT JOIN categories c ON c.id = l.account_id
          WHERE l.organization_id = $1 ORDER BY c.system_code`,
        [orgId],
      );
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.account_id !== null)).toBe(true);
      expect(rows.map((r) => r.system_code)).toEqual(["AR", "SALES", "VAT_OUTPUT"]);
      expect(rows.map((r) => r.type)).toEqual(["asset", "income", "liability"]);
    });

    it("🔴 shows Sales Revenue as REVENUE, not as a negative expense", async () => {
      const is = await inTenant(() => reportsService.incomeStatement("2026-01-01", "2026-12-31"));

      const revenue = is.revenue.find((r: { name: string }) => /Sales|Revenue/i.test(r.name));
      expect(revenue, "Sales Revenue must appear under revenue").toBeDefined();
      expect(revenue!.amount).toBe(1000);
      expect(is.totalRevenue).toBe(1000);

      // Before M13 this line WAS in the expense list, at −1000.
      expect(is.expenses.find((e: { name: string }) => /Sales|Revenue/i.test(e.name))).toBeUndefined();
      expect(is.totalExpenses).toBe(0);

      // VAT is a LIABILITY — it belongs in neither revenue nor expenses.
      expect(is.revenue.find((r: { name: string }) => /VAT/i.test(r.name))).toBeUndefined();
      expect(is.expenses.find((e: { name: string }) => /VAT/i.test(e.name))).toBeUndefined();

      // And the source really is the ledger, not the transactions fallback.
      expect(is.source).toBe("journal_entries");
    });

    it("net profit is UNCHANGED by the fix — the bottom line was always right", async () => {
      // The whole reason this survived: the arithmetic netted out. Only the
      // composition was wrong, and composition is most of what the statement is
      // for. Pinning this proves M13 corrects presentation without restating.
      const is = await inTenant(() => reportsService.incomeStatement("2026-01-01", "2026-12-31"));
      expect(is.netIncome).toBe(1000);
    });

    it("the trial balance classifies the same lines, and still balances", async () => {
      const tb = await inTenant(() => reportsService.trialBalance("2026-01-01", "2026-12-31"));
      expect(tb.balanced).toBe(true);
      expect(tb.accounts.every((a: { type: string }) => a.type !== "other")).toBe(true);
    });
  });

  // ── AR agreement — the §5 deliverable ────────────────────────────────────

  describe("🔴 AR from the GL must AGREE with AR from the invoices table", () => {
    /**
     * The two computations must never diverge. Before M13 the balance sheet
     * bolted AR on from `invoices` while GL lines contributed nothing; the
     * moment AR lines classify as assets, adding both DOUBLE-COUNTS the whole
     * receivable. This asserts the survivor is right — and a divergence here
     * means something posted to AR that no invoice explains, or an invoice that
     * never posted, which is a genuine reconciliation defect.
     */
    async function arFromInvoices(): Promise<number> {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(
                  CASE WHEN document_type = 'credit_note' THEN -1 ELSE 1 END
                  * (total::numeric - paid_amount::numeric)), 0) AS ar
           FROM invoices
          WHERE organization_id = $1 AND status IN ('sent','paid')`,
        [orgId],
      );
      return Math.round(Number(rows[0].ar) * 100) / 100;
    }

    it("agrees for a single unpaid invoice", async () => {
      const bs = await inTenant(() => reportsService.balanceSheet("2026-12-31"));
      expect(bs.assets.accountsReceivable).toBe(await arFromInvoices());
      expect(bs.assets.accountsReceivable).toBe(1150);
    });

    it("agrees after a SECOND invoice — and AR is not double-counted in total assets", async () => {
      await issueInvoice(2, 500); // 500 + 75 VAT = 575
      const bs = await inTenant(() => reportsService.balanceSheet("2026-12-31"));

      expect(bs.assets.accountsReceivable).toBe(await arFromInvoices());
      expect(bs.assets.accountsReceivable).toBe(1725);

      // 🔴 The double-count guard. AR is an ordinary GL account now, already
      // inside `assets.items`; adding the old bolt-on as well would make total
      // assets 3450 instead of 1725.
      const sumOfItems = bs.assets.items.reduce((s: number, a: { amount: number }) => s + a.amount, 0);
      expect(bs.assets.total).toBe(Math.round(sumOfItems * 100) / 100);
      expect(bs.assets.total).toBe(1725);
    });

    it("agrees after a partial payment", async () => {
      const id = await issueInvoice(3, 200); // 230 gross
      await inTenant(() => invoicesService.pay(id, { amount: 100 }, userId));
      const bs = await inTenant(() => reportsService.balanceSheet("2026-12-31"));
      expect(bs.assets.accountsReceivable).toBe(await arFromInvoices());
    });

    it("the balance sheet still BALANCES", async () => {
      const bs = await inTenant(() => reportsService.balanceSheet("2026-12-31"));
      expect(bs.balanced, bs.warning ?? "balance sheet must balance").toBe(true);
    });
  });

  // ── 🔴 The guard the owner asked to protect most carefully ───────────────

  describe("🔴🔴 TAX FIGURES MUST NOT MOVE — DO NOT DELETE THIS BLOCK", () => {
    /**
     * ══════════════════════════════════════════════════════════════════════
     * M13 is a PRESENTATION fix. A tax figure moving inside it would be the
     * worst possible outcome of this milestone: the VAT return is filed with
     * ZATCA, and a silent shift in it is a filing error the tenant carries,
     * not us.
     *
     * Neither reads the general ledger: the VAT return is computed from
     * INVOICES and BILLS, cash flow from TRANSACTIONS. (The M13 design note
     * said "all three read transactions" — that was wrong about the VAT return,
     * and the correction is exactly why this is asserted rather than argued.)
     * If a future change moves either onto the GL, this fails, and that is the
     * point.
     *
     * 🔴 M17.0 — the Zakat probe was REMOVED from this test, and its absence is
     * deliberate in BOTH directions:
     *
     *   1. It was vacuous. It compared `summaryService.getZakat()` before and
     *      after, and that endpoint summed rows flagged `is_zakat_relevant` —
     *      a flag only ONE rule ever wrote (Tadawul/investment), which no
     *      fixture here creates. Both sides were 0, so the assertion would have
     *      stayed green through any defect it claimed to guard.
     *   2. The property it asserted is now INTENTIONALLY FALSE. Owner decision
     *      Q4: the Zakat working paper (M17.4) is derived FROM THE GENERAL
     *      LEDGER, by design. Re-adding a "Zakat must not move when the GL
     *      moves" assertion here would encode the opposite of the spec.
     *
     * So do not restore it. The Zakat module gets its own guards, asserting
     * that the base DOES track the balance sheet.
     *
     * If you are here because this test is in your way: it is not in your way.
     * It is telling you that a change to GL classification has reached the VAT
     * return or cash flow, which needs a decision, not a deletion.
     * ══════════════════════════════════════════════════════════════════════
     */
    it("🔴 a GL-ONLY entry moves NO tax figure — VAT or cash flow", async () => {
      // The strongest available form of this assertion.
      //
      // We post a journal entry that credits SALES and VAT_OUTPUT with NO
      // invoice, NO bill and NO transaction behind it. If any tax report read
      // the general ledger, these numbers would move. They must not.
      //
      // This is stronger than asserting a fixed figure: it isolates the GL as
      // the only variable, so it keeps working as fixtures change, and it fails
      // for exactly one reason — a tax report started reading the ledger.
      const before = {
        vat: await inTenant(() => reportsService.vatReturn("2026-01-01", "2026-12-31")),
        cash: await inTenant(() => reportsService.cashFlow("2026-01-01", "2026-12-31")),
      };

      await inTenant(() =>
        postJournalEntry({
          entryNumber: "COA-GL-ONLY",
          date: "2026-06-15",
          description: "GL-only revenue with no invoice behind it",
          lines: [
            { systemCode: "AR", accountName: "Accounts Receivable", debitAmount: 9999, creditAmount: 0 },
            { systemCode: "SALES", accountName: "Sales Revenue", debitAmount: 0, creditAmount: 8695.65 },
            { systemCode: "VAT_OUTPUT", accountName: "VAT Payable", debitAmount: 0, creditAmount: 1303.35 },
          ],
        }),
      );

      const after = {
        vat: await inTenant(() => reportsService.vatReturn("2026-01-01", "2026-12-31")),
        cash: await inTenant(() => reportsService.cashFlow("2026-01-01", "2026-12-31")),
      };

      // 🔴 Every box of the VAT return, unchanged.
      expect(after.vat.salesSection).toEqual(before.vat.salesSection);
      expect(after.vat.purchasesSection).toEqual(before.vat.purchasesSection);

      // 🔴 Cash flow, unchanged.
      expect(after.cash.netChange).toBe(before.cash.netChange);
      expect(after.cash.operating.total).toBe(before.cash.operating.total);

      // Sanity: the entry really did land in the ledger, so the assertions above
      // are meaningful rather than vacuous. The income statement SHOULD move.
      const is = await inTenant(() => reportsService.incomeStatement("2026-01-01", "2026-12-31"));
      expect(is.totalRevenue).toBeGreaterThan(1000);
    });
  });

  // ── Fail-closed + the manual-JE hole ─────────────────────────────────────

  describe("fail closed rather than writing a NULL", () => {
    it("🔴 refuses to post when an account cannot be resolved", async () => {
      await expect(
        inTenant(() =>
          postJournalEntry({
            entryNumber: "COA-FAIL-1",
            date: "2026-06-15",
            description: "unresolvable",
            lines: [
              // Not a system code this platform knows.
              { systemCode: "NOT_A_REAL_ACCOUNT" as never, accountName: "Nope", debitAmount: 10, creditAmount: 0 },
              { systemCode: "CASH", accountName: "Cash and Bank", debitAmount: 0, creditAmount: 10 },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(AccountResolutionError);

      // And nothing was written — resolution happens before any insert, so an
      // incomplete chart cannot leave a half-posted entry behind.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number = 'COA-FAIL-1'`,
        [orgId],
      );
      expect(rows[0].n).toBe(0);
    });

    it("🔴 a manual journal entry line must name an account", async () => {
      // The same hole reached from the manual side: a line with no account is
      // invisible to both the income statement and the balance sheet.
      await expect(
        inTenant(() =>
          journalEntriesService.create(
            {
              entryNumber: "COA-MANUAL-1",
              date: "2026-06-15",
              description: "no account",
              lines: [
                { accountName: "Something", debitAmount: 10, creditAmount: 0 },
                { accountName: "Other", debitAmount: 0, creditAmount: 10 },
              ],
            },
            userId,
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // ── Multi-company period locks (queue A4) ────────────────────────────────

  describe("period locks are scoped per COMPANY (A4)", () => {
    it("🔴 company A closing a period does not block company B", async () => {
      const companyB = (
        await pool.query(
          `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'CoA Co B','1010101011','399999999999994') RETURNING id`,
          [orgId],
        )
      ).rows[0].id;

      // Company A locks June.
      await pool.query(
        `INSERT INTO period_locks (organization_id, company_id, period, locked_by) VALUES ($1,$2,'2026-06',$3)`,
        [orgId, companyId, userId],
      );

      // Company B must still be able to post into June. Before A4 the lookup
      // filtered on `period` alone, so one company's close froze every other
      // company in the organization.
      const connB = await beginTenantConnection({ organizationId: orgId, companyId: companyB, role: "authenticated" });
      try {
        await connB.run(() =>
          auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.13" }, () =>
            postJournalEntry({
              entryNumber: "COA-B-1",
              date: "2026-06-20",
              description: "company B posts into a period company A closed",
              lines: [
                { systemCode: "CASH", accountName: "Cash and Bank", debitAmount: 50, creditAmount: 0 },
                { systemCode: "SALES", accountName: "Sales Revenue", debitAmount: 0, creditAmount: 50 },
              ],
            }),
          ),
        );
        await connB.commit();
      } catch (err) {
        await connB.rollback();
        throw err;
      }

      // And company A is still genuinely locked.
      const connA = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
      await expect(
        connA.run(() =>
          auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.13" }, () =>
            postJournalEntry({
              entryNumber: "COA-A-LOCKED",
              date: "2026-06-20",
              description: "company A is locked",
              lines: [
                { systemCode: "CASH", accountName: "Cash and Bank", debitAmount: 50, creditAmount: 0 },
                { systemCode: "SALES", accountName: "Sales Revenue", debitAmount: 0, creditAmount: 50 },
              ],
            }),
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 423 });
      await connA.rollback();
    });

    it("🔴 the ROUTE layer is company-scoped too — list, lock and UNLOCK (M14)", async () => {
      // M13 fixed `checkPeriodOpen` (the posting-path check). The repository
      // behind the period-lock ROUTES filtered on `period` alone, so in a
      // multi-company org:
      //   - list()            showed another company's locks;
      //   - findByPeriod()    reported "already locked" because a DIFFERENT
      //                       company held the lock, so the real one could never
      //                       be created;
      //   - removeByPeriod()  deleted EVERY company's lock for that period —
      //                       one company's unlock silently reopened closed books
      //                       for all of them. That is the dangerous one.
      const companyC = (
        await pool.query(
          `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'CoA Co C','1010101012','399999999999995') RETURNING id`,
          [orgId],
        )
      ).rows[0].id;

      const asCompany = async <T>(company: string, fn: () => Promise<T>): Promise<T> => {
        const conn = await beginTenantConnection({ organizationId: orgId, companyId: company, role: "authenticated" });
        try {
          const out = await conn.run(() =>
            auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.13" }, fn),
          );
          await conn.commit();
          return out;
        } catch (err) {
          await conn.rollback();
          throw err;
        }
      };

      // Company A already locked 2026-06 in the previous test.
      // C must not see it, and must be able to lock the SAME period itself.
      expect(await asCompany(companyC, () => periodLocksService.list())).toHaveLength(0);
      await asCompany(companyC, () => periodLocksService.lock({ period: "2026-06", userId }));
      expect(await asCompany(companyC, () => periodLocksService.list())).toHaveLength(1);

      // 🔴 And C unlocking must NOT reopen A's books.
      await asCompany(companyC, () => periodLocksService.unlock("2026-06"));
      expect(await asCompany(companyC, () => periodLocksService.list())).toHaveLength(0);

      const stillLocked = await pool.query(
        `SELECT count(*)::int AS n FROM period_locks WHERE organization_id=$1 AND company_id=$2 AND period='2026-06'`,
        [orgId, companyId],
      );
      expect(stillLocked.rows[0].n, "company A's lock must survive company C's unlock").toBe(1);
    });
  });
});
