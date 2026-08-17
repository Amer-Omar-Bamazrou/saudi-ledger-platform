/**
 * Flaw #1 (Option A) — accepted transactions ARE ledger facts.
 *
 * The defect, observed live on an SME statement: an income statement showing
 * **0.00 of expenses** for a month with 45,063.25 of accepted bank debits,
 * beside a dashboard showing all of it. Two report families, two answers, and
 * for a cash-based SME the P&L was empty (meta-finding #9).
 *
 * The property this suite defends is the one Option B could not give:
 * **the P&L ties to the ledger**. Every case below asserts a figure AND the
 * trial balance still balancing, because a posting scheme that produces a
 * right-looking P&L and an unbalanced ledger is worse than no posting.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { summaryService } from "../services/summary.service";
import { reportsService } from "../services/reports.service";
import { invoicesService } from "../services/invoices.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[transactions-to-ledger] no real DATABASE_URL — skipping.");

const SLUG = "txn-to-ledger";
const EMAIL = "txn-to-ledger@test.local";
const FROM = "2026-11-01";
const TO = "2026-11-30";

describeMaybe("flaw #1 — acceptance posts to the ledger", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let accountId = 0;
  let customerId = 0;

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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Ledger Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'TL','1010101021','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','TL',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'TL Client') RETURNING id`, [orgId])).rows[0].id;
    accountId = (
      await pool.query(
        `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'TL SAR','Riyad') RETURNING id`,
        [orgId, companyId],
      )
    ).rows[0].id;
  });

  afterAll(cleanup);

  const upload = (rows: unknown[], auto = true) =>
    inTenant(() => transactionsService.upload({ rows, autoCategrize: auto, bankAccountId: accountId } as never));

  const idOf = async (like: string) =>
    Number(
      (await pool.query(`SELECT id FROM transactions WHERE organization_id = $1 AND description LIKE $2 LIMIT 1`, [orgId, like]))
        .rows[0].id,
    );

  const balanced = async () => {
    const tb = (await inTenant(() => reportsService.trialBalance(FROM, TO))) as { totalDebit: number; totalCredit: number };
    expect(tb.totalDebit).toBe(tb.totalCredit);
  };

  it("🔴 an accepted expense reaches the INCOME STATEMENT, not just the dashboard", async () => {
    const before = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalExpenses: number };
    expect(before.totalExpenses).toBe(0);

    await upload([{ date: "2026-11-03", description: "SADAD PAYMENT - STC 0119", amount: 862.5, currency: "SAR", type: "debit" }]);
    const id = await idOf("SADAD%");
    await inTenant(() => transactionsService.acceptPending([id]));

    const after = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalExpenses: number };
    expect(after.totalExpenses).toBe(862.5); // GROSS — no input-VAT line (no tax invoice)
    await balanced();

    const { rows } = await pool.query(`SELECT journal_entry_id FROM transactions WHERE id = $1`, [id]);
    expect(rows[0].journal_entry_id).not.toBeNull();
  });

  it("🔴 the dashboard and the P&L now agree BY CONSTRUCTION", async () => {
    const [dash, pl] = await Promise.all([
      inTenant(() => summaryService.getSummary({ dateFrom: FROM, dateTo: TO })),
      inTenant(() => reportsService.incomeStatement(FROM, TO)),
    ]);
    expect((dash as { totalExpenses: number }).totalExpenses).toBe((pl as { totalExpenses: number }).totalExpenses);
    expect((dash as { totalIncome: number }).totalIncome).toBe((pl as { totalRevenue: number }).totalRevenue);
  });

  it("🔴 an UNCATEGORISED acceptance posts to SUSPENSE — not to expenses", async () => {
    await upload([{ date: "2026-11-05", description: "REF 8891 UNKNOWN", amount: 5000, currency: "SAR", type: "debit" }], false);
    const id = await idOf("REF 8891%");
    const before = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalExpenses: number };
    await inTenant(() => transactionsService.acceptPending([id]));
    const after = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalExpenses: number };

    expect(after.totalExpenses).toBe(before.totalExpenses); // "I don't know" is not an expense
    const { rows } = await pool.query(
      `SELECT c.system_code, l.debit_amount::text FROM journal_entry_lines l
         JOIN categories c ON c.id = l.account_id
        WHERE l.organization_id = $1 AND c.system_code = 'SUSPENSE'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].debit_amount).toBe("5000.00"); // a visible balance somebody must clear
    await balanced();
  });

  it("🔴 paying a VAT liability is NOT an expense (0036 re-typing, proven through the P&L)", async () => {
    await upload([{ date: "2026-11-08", description: "ZATCA VAT PAYMENT Q4", amount: 12500, currency: "SAR", type: "debit" }]);
    const id = await idOf("ZATCA VAT PAYMENT%");
    const before = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalExpenses: number };
    await inTenant(() => transactionsService.acceptPending([id]));
    const after = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalExpenses: number };

    expect(after.totalExpenses).toBe(before.totalExpenses); // settles a liability
    await balanced();
  });

  it("🔴 A — a transfer POSTS (cash is right, P&L untouched); a settlement still never does", async () => {
    // Rewritten for A (GL owns cash): the old assertion here — "transfers and
    // settlements never post", pinned as journal_entry_id IS NULL for both —
    // became a guard for the retired behaviour the day transfers started
    // posting. The properties that MATTER survive unchanged: no P&L movement
    // from either row, and one writer per effect for the settlement.
    await upload([{ date: "2026-11-10", description: "ATM CASH WITHDRAWAL - ANB", amount: 2000, currency: "SAR", type: "debit" }]);
    const transferId = await idOf("ATM CASH%");

    const inv = await inTenant(() =>
      invoicesService.create(
        { invoiceNumber: "TL-INV-1", date: "2026-11-02", customerId, items: [{ description: "S", quantity: 1, unitPrice: 1000, vatRate: 15 }] },
        userId,
        { autoApprove: false },
      ),
    );
    await inTenant(() => invoicesService.approve(inv.id, userId));
    await upload([{ date: "2026-11-12", description: "INCOMING TL-INV-1 PAYMENT", amount: 1150, currency: "SAR", type: "credit" }], false);
    const settleId = await idOf("INCOMING TL-INV-1%");

    const before = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalRevenue: number; totalExpenses: number };
    await inTenant(() => transactionsService.acceptPending([transferId]));
    await inTenant(() => transactionsService.settle(settleId, { invoiceId: inv.id }, userId));
    const after = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalRevenue: number; totalExpenses: number };

    // The invoice already recognised the revenue; neither the transfer nor the
    // settlement may add more — and the transfer is not an expense either.
    expect(after.totalRevenue).toBe(before.totalRevenue);
    expect(after.totalExpenses).toBe(before.totalExpenses);

    // The transfer POSTED: undeclared, so Cr Cash / Dr Transfers-awaiting-
    // declaration — the bank genuinely moved, and the offset demands a
    // declaration rather than being guessed at.
    const { rows: [tf] } = await pool.query(`SELECT journal_entry_id FROM transactions WHERE id = $1`, [transferId]);
    expect(tf.journal_entry_id).not.toBeNull();
    const { rows: lines } = await pool.query(
      `SELECT c.system_code, l.debit_amount::numeric AS debit, l.credit_amount::numeric AS credit
         FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
        WHERE l.journal_entry_id = $1 ORDER BY c.system_code`,
      [tf.journal_entry_id],
    );
    expect(lines).toEqual([
      expect.objectContaining({ system_code: "CASH", credit: "2000.00" }),
      expect.objectContaining({ system_code: "TRANSFER_SUSPENSE", debit: "2000.00" }),
    ]);

    // The settlement did NOT post — its cash effect belongs to the pay path.
    const { rows: [st] } = await pool.query(`SELECT journal_entry_id FROM transactions WHERE id = $1`, [settleId]);
    expect(st.journal_entry_id).toBeNull();
    await balanced();
  });

  it("🔴 A — declaring a direction MOVES the posted balance: suspense → clearing, or → equity for external", async () => {
    const id = await idOf("ATM CASH%"); // posted to TRANSFER_SUSPENSE above

    await inTenant(() => transactionsService.update(id, { transferDirection: "own_account" } as never));
    const balances = async () => {
      const { rows } = await pool.query(
        `SELECT c.system_code, COALESCE(SUM(l.debit_amount::numeric - l.credit_amount::numeric), 0) AS bal
           FROM journal_entry_lines l
           JOIN categories c ON c.id = l.account_id
           JOIN journal_entries je ON je.id = l.journal_entry_id
          -- 'reversed' is IN the books (its mirror cancels it) — the same
          -- rule the report filters follow; posted-only here would see only
          -- the mirror and double-negate, the very defect this build fixed.
          WHERE l.organization_id = $1 AND je.status IN ('posted', 'reversed')
            AND c.system_code IN ('TRANSFER_SUSPENSE', 'TRANSFER_CLEARING', 'EXTERNAL_TRANSFERS')
          GROUP BY c.system_code`,
        [orgId],
      );
      return Object.fromEntries(rows.map((r: { system_code: string; bal: string }) => [r.system_code, Number(r.bal)]));
    };

    let b = await balances();
    expect(b.TRANSFER_SUSPENSE ?? 0).toBe(0); // reversed out
    expect(b.TRANSFER_CLEARING).toBe(2000); // the money sits in an own account we do not track

    // Re-declared external: clearing empties, equity records the distribution.
    await inTenant(() => transactionsService.update(id, { transferDirection: "external" } as never));
    b = await balances();
    expect(b.TRANSFER_CLEARING ?? 0).toBe(0);
    expect(b.EXTERNAL_TRANSFERS).toBe(2000); // Dr equity — a declared distribution
    await balanced();
  });

  it("🔴 editing a posted row REVERSES and re-posts — the P&L follows the correction", async () => {
    const id = await idOf("REF 8891%"); // currently in SUSPENSE
    const { rows: [telecom] } = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'TELECOM'`,
      [orgId],
    );
    const before = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalExpenses: number };

    await inTenant(() => transactionsService.update(id, { categoryId: Number(telecom.id) } as never));

    const after = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalExpenses: number };
    expect(after.totalExpenses).toBe(Math.round((before.totalExpenses + 5000) * 100) / 100);

    // The original entry is reversed, not edited — the audit trail stands.
    const { rows: reversed } = await pool.query(
      `SELECT status FROM journal_entries WHERE organization_id = $1 AND status = 'reversed'`,
      [orgId],
    );
    expect(reversed.length).toBeGreaterThanOrEqual(1);
    await balanced();
  });

  it("a pending row still moves NOTHING — acceptance remains the gate", async () => {
    await upload([{ date: "2026-11-15", description: "SADAD PAYMENT - STC 0999", amount: 230, currency: "SAR", type: "debit" }]);
    const before = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalExpenses: number };
    const id = await idOf("SADAD PAYMENT - STC 0999%");
    const { rows } = await pool.query(`SELECT journal_entry_id, review_status FROM transactions WHERE id = $1`, [id]);
    expect(rows[0].review_status).toBe("pending_review");
    expect(rows[0].journal_entry_id).toBeNull();
    const after = (await inTenant(() => reportsService.incomeStatement(FROM, TO))) as { totalExpenses: number };
    expect(after.totalExpenses).toBe(before.totalExpenses);
  });

  it("the balance sheet balances with transaction postings present — the tie Option B would have broken", async () => {
    const bs = (await inTenant(() => reportsService.balanceSheet("2026-11-30"))) as { balanced: boolean; warning?: string };
    expect(bs.balanced, bs.warning ?? "balance sheet must balance").toBe(true);
  });
});
