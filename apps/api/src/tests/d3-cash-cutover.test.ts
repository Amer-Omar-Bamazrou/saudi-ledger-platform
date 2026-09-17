/**
 * D-3 / G3 — THE CASH CUT-OVER under the ANNOTATION model: classification,
 * one-to-one evidence pairing, refusal, attribution, conservation,
 * idempotency, concurrency (2026-09-17).
 *
 * Decision record: docs/product/accounting-architecture-decision-pack.md §D-3;
 * as-built: docs/product/design-per-bank-cash.md.
 *
 * ── How the fixture makes HEADER-ERA history ──────────────────────────────
 * Since 0073 nothing can post to "Cash and Bank" (the DB trigger refuses it,
 * owner included). Pre-cut-over history is therefore built the way it was
 * built before 0073: the header is briefly re-opened (owner-only — the
 * protection trigger bypasses the owner for exactly this kind of fixture
 * work), lines are inserted in the shapes the posting paths produced, and the
 * header is closed again. Every source record the classifier consults
 * (transactions, payment records, settlement rows) is real.
 *
 * ── What is proven here, and what would have to be broken for each to fail ──
 *   • the mandatory regression: a one-bank company's unidentified payment is
 *     AMBIGUOUS — any inference from the bank count would flip it;
 *   • A2 pairs ONE settlement row with ONE payment record per document/date/
 *     amount group — a rule that reused a row (2 payments ↔ 1 settlement) or
 *     picked among rows (1 ↔ 2) would turn these AMBIGUOUS cases DETERMINISTIC,
 *     and case C's distinct transaction ids prove no row stood for two lines;
 *   • the commit changes NO journal line — a digest over id/entry/account/
 *     name/money is equal before and after, so any rewrite fails it;
 *   • per-bank figures come from attributions, not from moved lines — the
 *     header still carries the lines, yet each bank's ledger balance is exact;
 *   • reruns and concurrent runs cannot duplicate or strand — the unique
 *     line_id, the advisory lock and the "nothing to do" path are each hit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { cashCutoverService, CashCutoverBlockedError, type ClassifiedLine } from "../services/accounting/cashCutover.service";
import { pairOneToOne } from "../services/accounting/evidencePairing";
import { transactionsService } from "../services/transactions.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { reportsService } from "../services/reports.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { cashService } from "../services/cash.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "d3-cutover";
const SLUG_OTHER = "d3-cutover-other";
const EMAIL = "d3-cutover@test.local";

describe("pairOneToOne — the generic evidence rule (pure)", () => {
  type R = { id: number; k: string };
  type E = { id: number; k: string };
  const pair = (rs: R[], es: E[]) => pairOneToOne(rs, es, { recordId: (r) => r.id, recordKey: (r) => r.k, evidenceKey: (e) => e.k });

  it("1 ↔ 1 pairs; the evidence is consumed exactly once", () => {
    const out = pair([{ id: 1, k: "d|100" }], [{ id: 9, k: "d|100" }]);
    expect(out.paired.get(1)?.id).toBe(9);
    expect(out.ambiguous.size).toBe(0);
    expect(out.unconsumedEvidence).toEqual([]);
  });
  it("🔴 2 records ↔ 1 evidence: BOTH ambiguous, the row stands for neither", () => {
    const out = pair([{ id: 1, k: "d|100" }, { id: 2, k: "d|100" }], [{ id: 9, k: "d|100" }]);
    expect(out.paired.size).toBe(0);
    expect([...out.ambiguous.keys()].sort()).toEqual([1, 2]);
    expect(out.unconsumedEvidence.map((e) => e.id)).toEqual([9]);
  });
  it("🔴 1 record ↔ 2 evidence: ambiguous, neither row chosen", () => {
    const out = pair([{ id: 1, k: "d|100" }], [{ id: 9, k: "d|100" }, { id: 10, k: "d|100" }]);
    expect(out.paired.size).toBe(0);
    expect(out.ambiguous.has(1)).toBe(true);
  });
  it("🔴 n ↔ n with n > 1 is ambiguous too — pairing them would need an ordering, and an ordering is not evidence", () => {
    const out = pair([{ id: 1, k: "d|100" }, { id: 2, k: "d|100" }], [{ id: 9, k: "d|100" }, { id: 10, k: "d|100" }]);
    expect(out.paired.size).toBe(0);
    expect(out.ambiguous.size).toBe(2);
    expect(out.ambiguous.get(1)).toMatch(/ordering is not evidence/);
  });
  it("distinct groups pair independently; order of input is irrelevant", () => {
    const a = pair([{ id: 1, k: "d1|300" }, { id: 2, k: "d2|700" }], [{ id: 9, k: "d2|700" }, { id: 8, k: "d1|300" }]);
    const b = pair([{ id: 2, k: "d2|700" }, { id: 1, k: "d1|300" }], [{ id: 8, k: "d1|300" }, { id: 9, k: "d2|700" }]);
    for (const out of [a, b]) {
      expect(out.paired.get(1)?.id).toBe(8);
      expect(out.paired.get(2)?.id).toBe(9);
    }
  });
  it("a record with no evidence is unmatched, not ambiguous", () => {
    const out = pair([{ id: 1, k: "d|100" }], [{ id: 9, k: "d|999" }]);
    expect(out.unmatched.map((r) => r.id)).toEqual([1]);
    expect(out.unconsumedEvidence.map((e) => e.id)).toEqual([9]);
  });
});

describeMaybe("D-3 — the per-bank cash cut-over (annotation)", () => {
  let orgId = "";
  let userId = 0;
  let headerId = 0;
  let c1 = ""; let c1BankA = 0; let c1BankB = 0;          // mixed: deterministic AND blocking shapes
  let c2 = ""; let c2Bank = 0;                            // exactly one bank — the mandatory regression
  let c3 = ""; let c3BankA = 0; let c3BankB = 0;          // entirely deterministic — commits
  let c4 = ""; let c4Bank = 0;                            // deterministic — rollback + concurrency
  let c5 = ""; let c5BankA = 0; let c5BankB = 0;          // A2 pairing cases A–E, mirror case F
  let otherOrgId = ""; let otherCompanyId = "";
  let customerId = 0; let vendorId = 0;

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

  const cleanup = async () => {
    for (const slug of [SLUG, SLUG_OTHER]) {
      const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
      await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
      await pool.query(`DELETE FROM bill_payments WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${org})`);
      for (const t of [
        "cash_line_bank_attributions", "cash_cutover_runs", "journal_entry_lines", "journal_entries", "transactions",
        "invoice_items", "invoices", "bill_items", "bills", "customers", "vendors",
        "audit_logs", "organization_memberships", "bank_accounts", "categories", "companies",
      ]) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await pool.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
    }
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
  };

  // ── fixture builders (owner connection) ─────────────────────────────────
  const company = async (name: string, cr: string) =>
    (await pool.query(`INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,$2,$3) RETURNING id`, [orgId, name, cr])).rows[0].id as string;
  const bank = async (companyId: string, name: string) =>
    (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name, created_at) VALUES ($1,$2,$3,'ANB','2026-01-01') RETURNING id`, [orgId, companyId, name])).rows[0].id as number;
  const accountByCode = async (org: string, code: string) =>
    (await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = $2`, [org, code])).rows[0] as { id: number; name: string };
  const entry = async (org: string, companyId: string, entryNumber: string, date: string, lines: Array<{ accountId: number; accountName: string; dr: number; cr: number }>, opts: { status?: string; reversalOf?: number | null; reference?: string | null } = {}) => {
    const je = (await pool.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, reversal_of, reference, posted_at)
       VALUES ($1,$2,$3,$4,'fixture',$5,$6,$7,CASE WHEN $5 = 'draft' THEN NULL ELSE now() END) RETURNING id`,
      [org, companyId, entryNumber, date, opts.status ?? "posted", opts.reversalOf ?? null, opts.reference ?? null],
    )).rows[0].id as number;
    for (const l of lines) {
      await pool.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [org, companyId, je, l.accountId, l.accountName, l.dr, l.cr]);
    }
    return je;
  };
  const transaction = async (companyId: string, o: { date: string; description: string; amount: number; type: "debit" | "credit"; bankAccountId: number | null; kind?: string; journalEntryId?: number | null; settlesInvoiceId?: number | null; settlesBillId?: number | null }) =>
    (await pool.query(
      `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, kind, review_status, bank_account_id, journal_entry_id, settles_invoice_id, settles_bill_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'accepted',$8,$9,$10,$11) RETURNING id`,
      [orgId, companyId, o.date, o.description, o.amount, o.type, o.kind ?? "operating", o.bankAccountId, o.journalEntryId ?? null, o.settlesInvoiceId ?? null, o.settlesBillId ?? null],
    )).rows[0].id as number;
  const invoice = async (companyId: string, number: string, total: number, paid: number) =>
    (await pool.query(
      `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,$3,$4,'invoice','2026-03-01','2026-03-31',$5,0,$5,$6,$7) RETURNING id`,
      [orgId, companyId, customerId, number, total, paid, paid >= total ? "paid" : "sent"],
    )).rows[0].id as number;
  const invoicePayment = async (companyId: string, invoiceId: number, amount: number, paidAt: string, bankAccountId: number | null = null) =>
    (await pool.query(`INSERT INTO invoice_payments (organization_id, company_id, invoice_id, amount, paid_at, bank_account_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [orgId, companyId, invoiceId, amount, paidAt, bankAccountId])).rows[0].id as number;
  const bill = async (companyId: string, number: string, total: number) =>
    (await pool.query(
      `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,$3,$4,'2026-03-01','2026-03-31',$5,0,$5,$5,'paid') RETURNING id`,
      [orgId, companyId, vendorId, number, total],
    )).rows[0].id as number;
  const billPayment = async (companyId: string, billId: number, amount: number, paidAt: string, bankAccountId: number | null = null) =>
    (await pool.query(`INSERT INTO bill_payments (organization_id, company_id, bill_id, amount, paid_at, bank_account_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [orgId, companyId, billId, amount, paidAt, bankAccountId])).rows[0].id as number;
  const withHeaderOpen = async (org: string, fn: () => Promise<void>) => {
    await pool.query(`UPDATE categories SET is_posting = true WHERE organization_id = $1 AND system_code = 'CASH'`, [org]);
    try { await fn(); } finally { await pool.query(`UPDATE categories SET is_posting = false WHERE organization_id = $1 AND system_code = 'CASH'`, [org]); }
  };

  // ── observations ────────────────────────────────────────────────────────
  /** Every column of every line of THIS org that could express accounting identity. */
  const lineDigest = async () =>
    (await pool.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(id::text || ':' || journal_entry_id::text || ':' || account_id::text || ':' || account_name || ':' || debit_amount::text || ':' || credit_amount::text, ',' ORDER BY id), '')) AS d FROM journal_entry_lines WHERE organization_id = $1`, [orgId])).rows[0] as { n: number; d: string };
  const snapshot = async () => {
    const [c] = (await pool.query(`
      SELECT (SELECT count(*) FROM journal_entry_lines WHERE organization_id = $1) AS lines,
             (SELECT count(*) FROM journal_entries WHERE organization_id = $1) AS entries,
             (SELECT count(*) FROM categories WHERE organization_id = $1) AS categories,
             (SELECT count(*) FROM bank_accounts WHERE organization_id = $1) AS banks,
             (SELECT count(*) FROM transactions WHERE organization_id = $1) AS transactions,
             (SELECT count(*) FROM invoice_payments WHERE organization_id = $1) AS ipay,
             (SELECT count(*) FROM bill_payments WHERE organization_id = $1) AS bpay,
             (SELECT count(*) FROM cash_line_bank_attributions WHERE organization_id = $1) AS attributions,
             (SELECT count(*) FROM cash_cutover_runs WHERE organization_id = $1) AS runs`, [orgId])).rows;
    return { ...(c as Record<string, string>), digest: (await lineDigest()).d } as Record<string, string>;
  };
  const headerLines = async (companyId: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM journal_entry_lines WHERE company_id = $1 AND account_id = $2`, [companyId, headerId])).rows[0].n as number;
  const unattributed = async (companyId: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM journal_entry_lines l LEFT JOIN cash_line_bank_attributions a ON a.line_id = l.id WHERE l.company_id = $1 AND l.account_id = $2 AND a.id IS NULL`, [companyId, headerId])).rows[0].n as number;
  const attributionsOf = async (companyId: string) =>
    (await pool.query(`SELECT a.line_id, a.account_id, a.account_name, a.bank_account_id, a.gl_account_id, a.rule, a.run_id, a.classification FROM cash_line_bank_attributions a WHERE a.company_id = $1 ORDER BY a.line_id`, [companyId])).rows;
  const byNumber = (report: { lines: ClassifiedLine[] }, entryNumber: string) => {
    const l = report.lines.find((x) => x.entryNumber === entryNumber);
    if (!l) throw new Error(`no classified line for ${entryNumber}`);
    return l;
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Cutover Org','${SLUG}') RETURNING id`)).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Cutover Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Other Co') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','CO',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Cutover Customer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, name_ar) VALUES ($1,'Cutover Vendor','مورد') RETURNING id`, [orgId])).rows[0].id;
    c1 = await company("Mixed Co", "1010808081"); c2 = await company("One Bank Co", "1010808082");
    c3 = await company("Clean Co", "1010808083"); c4 = await company("Rollback Co", "1010808084");
    c5 = await company("Pairing Co", "1010808085");
    c1BankA = await bank(c1, "Mixed A"); c1BankB = await bank(c1, "Mixed B");
    c2Bank = await bank(c2, "The Only Bank");
    c3BankA = await bank(c3, "Clean A"); c3BankB = await bank(c3, "Clean B");
    c4Bank = await bank(c4, "Rollback Bank");
    c5BankA = await bank(c5, "Pair A"); c5BankB = await bank(c5, "Pair B");
    const header = await accountByCode(orgId, "CASH");
    headerId = header.id;
    const H = { accountId: header.id, accountName: header.name };
    const sales = await accountByCode(orgId, "SALES");
    const ar = await accountByCode(orgId, "AR");
    const ap = await accountByCode(orgId, "AP");
    const rent = await accountByCode(orgId, "RENT_UTILITIES");
    const S = { accountId: sales.id, accountName: sales.name };
    const AR = { accountId: ar.id, accountName: ar.name };
    const AP = { accountId: ap.id, accountName: ap.name };
    const RENT = { accountId: rent.id, accountName: rent.name };

    await withHeaderOpen(orgId, async () => {
      // ── Company ONE: every non-pairing shape ─────────────────────────────
      const je1 = await entry(orgId, c1, "TXN-PLACEHOLDER-1", "2026-02-10", [{ ...H, dr: 1000, cr: 0 }, { ...S, dr: 0, cr: 1000 }]);
      const t1 = await transaction(c1, { date: "2026-02-10", description: "LINKED WITH BANK", amount: 1000, type: "credit", bankAccountId: c1BankA, journalEntryId: je1 });
      await pool.query(`UPDATE journal_entries SET entry_number = $1, reference = $1 WHERE id = $2`, [`TXN-${t1}`, je1]);
      const t2 = await transaction(c1, { date: "2026-02-12", description: "NUMBERED WITH BANK", amount: 250, type: "debit", bankAccountId: c1BankB });
      await entry(orgId, c1, `TXN-${t2}`, "2026-02-12", [{ ...RENT, dr: 250, cr: 0 }, { ...H, dr: 0, cr: 250 }], { reference: `TXN-${t2}` });
      const t3 = await transaction(c1, { date: "2026-02-14", description: "NO BANK", amount: 300, type: "debit", bankAccountId: null });
      const je3 = await entry(orgId, c1, `TXN-${t3}`, "2026-02-14", [{ ...RENT, dr: 300, cr: 0 }, { ...H, dr: 0, cr: 300 }], { reference: `TXN-${t3}` });
      await pool.query(`UPDATE transactions SET journal_entry_id = $1 WHERE id = $2`, [je3, t3]);
      const inv1 = await invoice(c1, "CO-INV-1", 1150, 1150);
      const p1 = await invoicePayment(c1, inv1, 1150, "2026-02-20");
      await entry(orgId, c1, `GL-CO-INV-1-PAY-${p1}`, "2026-02-20", [{ ...H, dr: 1150, cr: 0 }, { ...AR, dr: 0, cr: 1150 }], { reference: "CO-INV-1" });
      await transaction(c1, { date: "2026-02-20", description: "SETTLES INV 1", amount: 1150, type: "credit", bankAccountId: c1BankA, kind: "settlement", settlesInvoiceId: inv1 });
      const inv2 = await invoice(c1, "CO-INV-2", 500, 500);
      const p2 = await invoicePayment(c1, inv2, 500, "2026-02-22");
      await entry(orgId, c1, `GL-CO-INV-2-PAY-${p2}`, "2026-02-22", [{ ...H, dr: 500, cr: 0 }, { ...AR, dr: 0, cr: 500 }], { reference: "CO-INV-2" });
      const b1 = await bill(c1, "CO-BILL-1", 400);
      const bp1 = await billPayment(c1, b1, 400, "2026-02-24", c1BankB);
      await entry(orgId, c1, `BILL-CO-BILL-1-PAY-${bp1}`, "2026-02-24", [{ ...AP, dr: 400, cr: 0 }, { ...H, dr: 0, cr: 400 }], { reference: "CO-BILL-1" });
      await entry(orgId, c1, "JE-000007", "2026-02-25", [{ ...H, dr: 5000, cr: 0 }, { ...S, dr: 0, cr: 5000 }]);
      const jeDel = await entry(orgId, c1, "TXN-999999901", "2026-02-26", [{ ...RENT, dr: 60, cr: 0 }, { ...H, dr: 0, cr: 60 }], { status: "reversed", reference: "TXN-999999901" });
      await entry(orgId, c1, "TXN-999999901-REV", "2026-02-27", [{ ...RENT, dr: 0, cr: 60 }, { ...H, dr: 60, cr: 0 }], { reversalOf: jeDel, reference: "TXN-999999901" });
      await entry(orgId, c1, "TXN-999999902", "2026-02-28", [{ ...RENT, dr: 70, cr: 0 }, { ...H, dr: 0, cr: 70 }], { reference: "TXN-999999902" });
      await entry(orgId, c1, "GL-CO-INV-9-PAY-999999903", "2026-03-01", [{ ...H, dr: 80, cr: 0 }, { ...AR, dr: 0, cr: 80 }], { reference: "CO-INV-9" });
      const t4 = await transaction(c1, { date: "2026-03-02", description: "AMOUNT MISMATCH", amount: 90, type: "debit", bankAccountId: c1BankA });
      await entry(orgId, c1, `TXN-${t4}`, "2026-03-02", [{ ...RENT, dr: 95, cr: 0 }, { ...H, dr: 0, cr: 95 }], { reference: `TXN-${t4}` });
      const je2 = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, `TXN-${t2}`])).rows[0].id;
      await pool.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [je2]);
      await entry(orgId, c1, `TXN-${t2}-REV`, "2026-03-03", [{ ...RENT, dr: 0, cr: 250 }, { ...H, dr: 250, cr: 0 }], { reversalOf: je2, reference: `TXN-${t2}` });

      // ── Company TWO: exactly one bank — the mandatory regression ─────────
      const t5 = await transaction(c2, { date: "2026-02-05", description: "ONE BANK, NO BANK ON ROW", amount: 120, type: "debit", bankAccountId: null });
      const je5 = await entry(orgId, c2, `TXN-${t5}`, "2026-02-05", [{ ...RENT, dr: 120, cr: 0 }, { ...H, dr: 0, cr: 120 }], { reference: `TXN-${t5}` });
      await pool.query(`UPDATE transactions SET journal_entry_id = $1 WHERE id = $2`, [je5, t5]);
      const inv3 = await invoice(c2, "CO-INV-3", 5000, 5000);
      const p3 = await invoicePayment(c2, inv3, 5000, "2026-02-06");
      await entry(orgId, c2, `GL-CO-INV-3-PAY-${p3}`, "2026-02-06", [{ ...H, dr: 5000, cr: 0 }, { ...AR, dr: 0, cr: 5000 }], { reference: "CO-INV-3" });

      // ── Company THREE: entirely deterministic ────────────────────────────
      const t6 = await transaction(c3, { date: "2026-01-10", description: "C3 RECEIPT A", amount: 3000, type: "credit", bankAccountId: c3BankA });
      const je6 = await entry(orgId, c3, `TXN-${t6}`, "2026-01-10", [{ ...H, dr: 3000, cr: 0 }, { ...S, dr: 0, cr: 3000 }], { reference: `TXN-${t6}` });
      await pool.query(`UPDATE transactions SET journal_entry_id = $1 WHERE id = $2`, [je6, t6]);
      const t7 = await transaction(c3, { date: "2026-02-11", description: "C3 RENT B", amount: 700, type: "debit", bankAccountId: c3BankB });
      const je7 = await entry(orgId, c3, `TXN-${t7}`, "2026-02-11", [{ ...RENT, dr: 700, cr: 0 }, { ...H, dr: 0, cr: 700 }], { reference: `TXN-${t7}` });
      await pool.query(`UPDATE transactions SET journal_entry_id = $1 WHERE id = $2`, [je7, t7]);
      const inv4 = await invoice(c3, "CO-INV-4", 2300, 2300);
      const p4 = await invoicePayment(c3, inv4, 2300, "2026-02-15");
      await entry(orgId, c3, `GL-CO-INV-4-PAY-${p4}`, "2026-02-15", [{ ...H, dr: 2300, cr: 0 }, { ...AR, dr: 0, cr: 2300 }], { reference: "CO-INV-4" });
      await transaction(c3, { date: "2026-02-15", description: "SETTLES INV 4", amount: 2300, type: "credit", bankAccountId: c3BankA, kind: "settlement", settlesInvoiceId: inv4 });
      await pool.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [je7]);
      await entry(orgId, c3, `TXN-${t7}-REV`, "2026-03-05", [{ ...RENT, dr: 0, cr: 700 }, { ...H, dr: 700, cr: 0 }], { reversalOf: je7, reference: `TXN-${t7}` });
      await entry(orgId, c3, `TXN-${t7}-P1`, "2026-02-11", [{ ...RENT, dr: 700, cr: 0 }, { ...H, dr: 0, cr: 700 }], { reference: `TXN-${t7}` });

      // ── Company FOUR: one deterministic line — rollback and concurrency ──
      const t8 = await transaction(c4, { date: "2026-02-01", description: "C4 RECEIPT", amount: 900, type: "credit", bankAccountId: c4Bank });
      const je8 = await entry(orgId, c4, `TXN-${t8}`, "2026-02-01", [{ ...H, dr: 900, cr: 0 }, { ...S, dr: 0, cr: 900 }], { reference: `TXN-${t8}` });
      await pool.query(`UPDATE transactions SET journal_entry_id = $1 WHERE id = $2`, [je8, t8]);

      // ── Company FIVE: the A2 pairing cases and the INCONSISTENT mirror ───
      const invA = await invoice(c5, "PAIR-A", 2000, 2000);
      const pA1 = await invoicePayment(c5, invA, 1000, "2026-02-20");
      const pA2 = await invoicePayment(c5, invA, 1000, "2026-02-20");
      await entry(orgId, c5, `GL-PAIR-A-PAY-${pA1}`, "2026-02-20", [{ ...H, dr: 1000, cr: 0 }, { ...AR, dr: 0, cr: 1000 }], { reference: "PAIR-A" });
      await entry(orgId, c5, `GL-PAIR-A-PAY-${pA2}`, "2026-02-20", [{ ...H, dr: 1000, cr: 0 }, { ...AR, dr: 0, cr: 1000 }], { reference: "PAIR-A" });
      await transaction(c5, { date: "2026-02-20", description: "SETTLES PAIR-A (one row)", amount: 1000, type: "credit", bankAccountId: c5BankA, kind: "settlement", settlesInvoiceId: invA });
      const invB = await invoice(c5, "PAIR-B", 500, 500);
      const pB = await invoicePayment(c5, invB, 500, "2026-02-21");
      await entry(orgId, c5, `GL-PAIR-B-PAY-${pB}`, "2026-02-21", [{ ...H, dr: 500, cr: 0 }, { ...AR, dr: 0, cr: 500 }], { reference: "PAIR-B" });
      await transaction(c5, { date: "2026-02-21", description: "SETTLES PAIR-B via A", amount: 500, type: "credit", bankAccountId: c5BankA, kind: "settlement", settlesInvoiceId: invB });
      await transaction(c5, { date: "2026-02-21", description: "SETTLES PAIR-B via B", amount: 500, type: "credit", bankAccountId: c5BankB, kind: "settlement", settlesInvoiceId: invB });
      const invC = await invoice(c5, "PAIR-C", 1000, 1000);
      const pC1 = await invoicePayment(c5, invC, 300, "2026-02-22");
      const pC2 = await invoicePayment(c5, invC, 700, "2026-02-25");
      await entry(orgId, c5, `GL-PAIR-C-PAY-${pC1}`, "2026-02-22", [{ ...H, dr: 300, cr: 0 }, { ...AR, dr: 0, cr: 300 }], { reference: "PAIR-C" });
      await entry(orgId, c5, `GL-PAIR-C-PAY-${pC2}`, "2026-02-25", [{ ...H, dr: 700, cr: 0 }, { ...AR, dr: 0, cr: 700 }], { reference: "PAIR-C" });
      await transaction(c5, { date: "2026-02-22", description: "SETTLES PAIR-C 300", amount: 300, type: "credit", bankAccountId: c5BankA, kind: "settlement", settlesInvoiceId: invC });
      await transaction(c5, { date: "2026-02-25", description: "SETTLES PAIR-C 700", amount: 700, type: "credit", bankAccountId: c5BankB, kind: "settlement", settlesInvoiceId: invC });
      const invD = await invoice(c5, "PAIR-D", 400, 400);
      const pD = await invoicePayment(c5, invD, 400, "2026-02-23");
      await entry(orgId, c5, `GL-PAIR-D-PAY-${pD}`, "2026-02-23", [{ ...H, dr: 400, cr: 0 }, { ...AR, dr: 0, cr: 400 }], { reference: "PAIR-D" });
      await transaction(c5, { date: "2026-02-24", description: "SETTLES PAIR-D a day later", amount: 400, type: "credit", bankAccountId: c5BankA, kind: "settlement", settlesInvoiceId: invD });
      const billD = await bill(c5, "PAIR-BILL-D", 250);
      const bpD = await billPayment(c5, billD, 250, "2026-03-01");
      await entry(orgId, c5, `BILL-PAIR-BILL-D-PAY-${bpD}`, "2026-03-01", [{ ...AP, dr: 250, cr: 0 }, { ...H, dr: 0, cr: 250 }], { reference: "PAIR-BILL-D" });
      await transaction(c5, { date: "2026-03-01", description: "SETTLES PAIR-BILL-D 260", amount: 260, type: "debit", bankAccountId: c5BankA, kind: "settlement", settlesBillId: billD });
      const invE = await invoice(c5, "PAIR-E", 900, 900);
      await invoicePayment(c5, invE, 900, "2026-02-26");
      await entry(orgId, c5, "GL-PAIR-E-PAY", "2026-02-26", [{ ...H, dr: 900, cr: 0 }, { ...AR, dr: 0, cr: 900 }], { reference: "PAIR-E" });
      await transaction(c5, { date: "2026-02-26", description: "SETTLES PAIR-E", amount: 900, type: "credit", bankAccountId: c5BankB, kind: "settlement", settlesInvoiceId: invE });
      const invE2 = await invoice(c5, "PAIR-E2", 1200, 1200);
      await invoicePayment(c5, invE2, 600, "2026-02-27");
      await invoicePayment(c5, invE2, 600, "2026-02-28");
      await entry(orgId, c5, "GL-PAIR-E2-PAY", "2026-02-27", [{ ...H, dr: 600, cr: 0 }, { ...AR, dr: 0, cr: 600 }], { reference: "PAIR-E2" });
      const jeF = await entry(orgId, c5, "JE-F-ORIGINAL", "2026-03-02", [{ ...H, dr: 77, cr: 0 }, { ...S, dr: 0, cr: 77 }], { status: "reversed" });
      await entry(orgId, c5, "JE-F-ORIGINAL-REV", "2026-03-03", [{ ...S, dr: 78, cr: 0 }, { ...H, dr: 0, cr: 78 }], { reversalOf: jeF });
      await entry(orgId, c5, "JE-F-ORPHAN-REV", "2026-03-04", [{ ...S, dr: 5, cr: 0 }, { ...H, dr: 0, cr: 5 }], { reversalOf: 999999904 });
    });

    const otherHeader = await accountByCode(otherOrgId, "CASH");
    const otherSales = await accountByCode(otherOrgId, "SALES");
    await withHeaderOpen(otherOrgId, async () => {
      await entry(otherOrgId, otherCompanyId, "JE-000001", "2026-02-01", [{ accountId: otherHeader.id, accountName: otherHeader.name, dr: 10, cr: 0 }, { accountId: otherSales.id, accountName: otherSales.name, dr: 0, cr: 10 }]);
    });
  });
  afterAll(cleanup);

  it("🔴 CLASSIFICATION: every non-pairing shape lands where the pack says, with the reviewer's fields", async () => {
    const r = await tenant(orgId, c1)(() => cashCutoverService.dryRun());
    expect(r.attributedBefore).toBe(0);
    expect(r.lines).toHaveLength(13);
    const byShape = Object.fromEntries(r.lines.map((l) => [l.entryNumber, l.classification]));
    const det = r.lines.filter((l) => l.classification === "DETERMINISTIC");
    expect(det.map((l) => l.rule).sort()).toEqual(["A0_payment_record_bank", "A1_transaction_link", "A1_transaction_number", "A2_settlement_pairing", "A3_mirror_of_attributed"]);
    expect(r.lines.find((l) => l.rule === "A0_payment_record_bank")!.knownBankAccountId).toBe(c1BankB);
    expect(r.lines.find((l) => l.rule === "A2_settlement_pairing")!.knownBankAccountId).toBe(c1BankA);
    expect(r.lines.find((l) => l.rule === "A3_mirror_of_attributed")!.knownBankAccountId).toBe(c1BankB);
    expect(r.counts).toEqual({ DETERMINISTIC: 5, AMBIGUOUS_REQUIRES_REVIEW: 3, UNMAPPABLE: 2, INCONSISTENT: 3 });
    expect(byShape["JE-000007"]).toBe("AMBIGUOUS_REQUIRES_REVIEW");
    expect(byShape["TXN-999999901"]).toBe("UNMAPPABLE");
    expect(byShape["TXN-999999901-REV"]).toBe("UNMAPPABLE");
    expect(byShape["TXN-999999902"]).toBe("INCONSISTENT");
    expect(byShape["GL-CO-INV-9-PAY-999999903"]).toBe("INCONSISTENT");
    expect(r.blocked).toBe(true);
    for (const l of r.lines.filter((x) => x.classification !== "DETERMINISTIC")) {
      expect(l.lineId).toBeGreaterThan(0);
      expect(l.currentAccountId).toBe(headerId);
      expect(Array.isArray(l.candidateBankAccountIds)).toBe(true);
      expect(l.requiredRemediation, `${l.entryNumber} names its remediation`).toBeTruthy();
      expect(l.targetGlAccountId).toBeNull();
    }
    const noBank = r.lines.find((l) => l.sourceKind === "transaction" && l.classification === "AMBIGUOUS_REQUIRES_REVIEW")!;
    expect(noBank.requiredRemediation).toMatch(/PATCH \/transactions\/\d+/);
  });

  it("🔴 MANDATORY: a company with EXACTLY ONE bank account does NOT make an unidentified historical payment deterministic", async () => {
    const r = await tenant(orgId, c2)(() => cashCutoverService.dryRun());
    expect(r.lines).toHaveLength(2);
    expect(r.counts.DETERMINISTIC).toBe(0);
    expect(r.counts.AMBIGUOUS_REQUIRES_REVIEW).toBe(2);
    for (const l of r.lines) {
      expect(l.classification).toBe("AMBIGUOUS_REQUIRES_REVIEW");
      expect(l.knownBankAccountId).toBeNull();
      expect(l.candidateBankAccountIds).toEqual([c2Bank]);
      expect(l.reason).toMatch(/not evidence/);
    }
    await expect(tenant(orgId, c2)(() => cashCutoverService.commit())).rejects.toBeInstanceOf(CashCutoverBlockedError);
    expect(await unattributed(c2)).toBe(2);
  });

  it("🔴 A2 ONE-TO-ONE: A (2 payments ↔ 1 settlement) and B (1 ↔ 2) are AMBIGUOUS; C (2 ↔ 2, distinct groups) is DETERMINISTIC with two DIFFERENT settlement rows; D (date or amount disagreement) is AMBIGUOUS; E legacy; F inconsistent mirrors", async () => {
    const r = await tenant(orgId, c5)(() => cashCutoverService.dryRun());
    const of = (prefix: string) => r.lines.filter((l) => l.entryNumber.startsWith(prefix));
    const A = of("GL-PAIR-A-PAY-");
    expect(A).toHaveLength(2);
    for (const l of A) {
      expect(l.classification).toBe("AMBIGUOUS_REQUIRES_REVIEW");
      expect(l.knownBankAccountId).toBeNull();
      expect(l.reason).toMatch(/2 records share the same document, date and amount but only 1 evidence row/);
    }
    const [B] = of("GL-PAIR-B-PAY-");
    expect(B!.classification).toBe("AMBIGUOUS_REQUIRES_REVIEW");
    expect(B!.reason).toMatch(/2 evidence rows agree with this one record/);
    const C = of("GL-PAIR-C-PAY-");
    expect(C).toHaveLength(2);
    expect(C.map((l) => l.classification)).toEqual(["DETERMINISTIC", "DETERMINISTIC"]);
    expect(C.map((l) => l.rule)).toEqual(["A2_settlement_pairing", "A2_settlement_pairing"]);
    expect(new Set(C.map((l) => l.transactionId)).size, "two distinct settlement rows — none reused").toBe(2);
    expect(C.find((l) => l.debit === 300)!.knownBankAccountId).toBe(c5BankA);
    expect(C.find((l) => l.debit === 700)!.knownBankAccountId).toBe(c5BankB);
    const [Dinv] = of("GL-PAIR-D-PAY-");
    expect(Dinv!.classification).toBe("AMBIGUOUS_REQUIRES_REVIEW");
    expect(Dinv!.reason).toMatch(/disagree on date or amount/);
    const [Dbill] = of("BILL-PAIR-BILL-D-PAY-");
    expect(Dbill!.classification).toBe("AMBIGUOUS_REQUIRES_REVIEW");
    expect(Dbill!.reason).toMatch(/disagree on date or amount/);
    const E = byNumber(r, "GL-PAIR-E-PAY");
    expect(E.classification).toBe("DETERMINISTIC");
    expect(E.rule).toBe("A2_settlement_pairing");
    expect(E.knownBankAccountId).toBe(c5BankB);
    expect(E.paymentId).not.toBeNull();
    const E2 = byNumber(r, "GL-PAIR-E2-PAY");
    expect(E2.classification).toBe("AMBIGUOUS_REQUIRES_REVIEW");
    expect(E2.reason).toMatch(/predates per-payment numbering; 2 payment record\(s\)/);
    const F1 = byNumber(r, "JE-F-ORIGINAL-REV");
    expect(F1.classification).toBe("INCONSISTENT");
    expect(F1.reason).toMatch(/no matching cash line/);
    const F2 = byNumber(r, "JE-F-ORPHAN-REV");
    expect(F2.classification).toBe("INCONSISTENT");
    expect(F2.reason).toMatch(/does not exist/);
    expect(r.blocked).toBe(true);
    await expect(tenant(orgId, c5)(() => cashCutoverService.commit())).rejects.toBeInstanceOf(CashCutoverBlockedError);
  });

  it("🔴 DRY-RUN WRITES NOTHING: every accounting table, the payment records and the line digest are unchanged; a recorded dry-run adds only its run row", async () => {
    const before = await snapshot();
    await tenant(orgId, c1)(() => cashCutoverService.dryRun());
    expect(await snapshot()).toEqual(before);
    await tenant(orgId, c1)(() => cashCutoverService.dryRun({ record: true }));
    const recorded = await snapshot();
    expect({ ...recorded, runs: before.runs }).toEqual(before);
    expect(Number(recorded.runs)).toBe(Number(before.runs) + 1);
  });

  it("🔴 A BLOCKED COMPANY IS REFUSED WHOLE: the commit throws before any write — no attribution, no run, no line touched", async () => {
    const before = await snapshot();
    await expect(tenant(orgId, c1)(() => cashCutoverService.commit())).rejects.toBeInstanceOf(CashCutoverBlockedError);
    expect(await snapshot()).toEqual(before);
    expect(await unattributed(c1)).toBe(13);
  });

  it("REMEDIATION THROUGH THE PRODUCT: naming the bank on the ambiguous transaction makes its line DETERMINISTIC; the Mark-Paid line still blocks (override policy pending)", async () => {
    const r0 = await tenant(orgId, c1)(() => cashCutoverService.dryRun());
    const noBank = r0.lines.find((l) => l.sourceKind === "transaction" && l.classification === "AMBIGUOUS_REQUIRES_REVIEW")!;
    const digest = (await lineDigest()).d;
    await tenant(orgId, c1)(() => transactionsService.update(noBank.transactionId!, { bankAccountId: c1BankA } as never));
    const r1 = await tenant(orgId, c1)(() => cashCutoverService.dryRun());
    const now = r1.lines.find((l) => l.lineId === noBank.lineId)!;
    expect(now.classification).toBe("DETERMINISTIC");
    expect(now.rule).toBe("A1_transaction_link");
    expect(r1.counts.AMBIGUOUS_REQUIRES_REVIEW).toBe(2);
    expect(r1.blocked).toBe(true);
    expect((await lineDigest()).d, "naming a bank on a row touches no journal line").toBe(digest);
  });

  it("🔴 A CLEAN COMPANY COMMITS AS ANNOTATION: not one journal line changes; every header line gains its attribution; cash, TB and BS are conserved; per-bank figures come from the attributions", async () => {
    const t3 = tenant(orgId, c3);
    const dry = await t3(() => cashCutoverService.dryRun());
    expect(dry.blocked).toBe(false);
    expect(dry.lines).toHaveLength(5);
    const digestBefore = await lineDigest();
    const headerBefore = await headerLines(c3);
    const bsBefore = await t3(() => reportsService.balanceSheet("2026-12-31"));
    const tbBefore = await t3(() => reportsService.trialBalance("2026-01-01", "2026-12-31"));
    const months = ["2026-01", "2026-02", "2026-03"];
    const cashBefore = await t3(() => cashService.reconciliation("2026-01", "2026-03", months));

    const result = await t3(() => cashCutoverService.commit());
    expect(result.state).toBe("committed");
    expect(result.attributed).toBe(5);
    expect(result.cashAfter).toBe(result.cashBefore);

    // Immutability: the lines are byte-for-byte what they were, STILL on the header.
    expect(await lineDigest()).toEqual(digestBefore);
    expect(await headerLines(c3)).toBe(headerBefore);
    expect(await unattributed(c3)).toBe(0);
    // Evidence: one attribution per line, naming the posted account AND the bank identity.
    const attrs = await attributionsOf(c3);
    expect(attrs).toHaveLength(5);
    const leafA = (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [c3BankA])).rows[0].id;
    const leafB = (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [c3BankB])).rows[0].id;
    for (const a of attrs) {
      expect(a.account_id).toBe(headerId);
      expect(a.account_name).toBe("Cash and Bank");
      expect(a.run_id).toBe(result.runId);
      expect(a.classification).toBe("DETERMINISTIC");
      expect(a.gl_account_id).toBe(a.bank_account_id === c3BankA ? leafA : leafB);
    }
    expect(attrs.filter((a) => a.bank_account_id === c3BankA)).toHaveLength(2);
    expect(attrs.filter((a) => a.bank_account_id === c3BankB)).toHaveLength(3);
    expect(new Set(attrs.map((a) => a.rule))).toEqual(new Set(["A1_transaction_link", "A2_settlement_pairing", "A3_mirror_of_attributed", "A1_transaction_number"]));
    // Reports: UNCHANGED — the trial balance still shows the history on "Cash and Bank".
    const bsAfter = await t3(() => reportsService.balanceSheet("2026-12-31"));
    const tbAfter = await t3(() => reportsService.trialBalance("2026-01-01", "2026-12-31"));
    expect(tbAfter).toEqual(tbBefore);
    expect(bsAfter).toEqual(bsBefore);
    expect(tbAfter.accounts.map((a: { name: string }) => a.name)).toContain("Cash and Bank");
    // Per-bank figures: through the one view — attributed history, nothing on the leaves yet.
    const viewA = await t3(() => bankAccountsService.getById(c3BankA));
    const viewB = await t3(() => bankAccountsService.getById(c3BankB));
    expect(viewA.ledgerBalance).toBe(3000 + 2300);
    expect(viewA.ledgerBalanceOnLeaf).toBe(0);
    expect(viewA.attributedHistory).toBe(5300);
    expect(viewB.ledgerBalance).toBe(-700 + 700 - 700);
    expect(viewB.attributedHistory).toBe(-700);
    const cashAfter = await t3(() => cashService.reconciliation("2026-01", "2026-03", months));
    expect(cashAfter.summary).toEqual(cashBefore.summary);
    const perA = await t3(() => cashService.reconciliation("2026-01", "2026-03", months, c3BankA));
    expect(perA.summary.ledgerCash).toBe(5300);
    // Evidence rows.
    const [run] = (await pool.query(`SELECT mode, state, cash_before::text AS b, cash_after::text AS a FROM cash_cutover_runs WHERE id = $1`, [result.runId])).rows;
    expect(run).toMatchObject({ mode: "commit", state: "committed" });
    expect(run.a).toBe(run.b);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action = 'cash_cutover' AND entity_id = $2`, [orgId, c3])).rows[0].n).toBe(1);
    // Isolation: no other company's lines were attributed.
    expect(await unattributed(c1)).toBe(13);
    expect(await unattributed(c2)).toBe(2);
    expect(await unattributed(c4)).toBe(1);
  });

  it("🔴 IDEMPOTENT: rerunning a completed company is a no-op (nothing_to_do, no run row, no duplicate), and the unique line_id refuses a second attribution outright", async () => {
    const t3 = tenant(orgId, c3);
    const before = await snapshot();
    const again = await t3(() => cashCutoverService.commit());
    expect(again.state).toBe("nothing_to_do");
    expect(again.attributed).toBe(0);
    expect(again.runId).toBeNull();
    expect(await snapshot()).toEqual(before);
    const [m] = (await pool.query(`SELECT line_id FROM cash_line_bank_attributions WHERE company_id = $1 LIMIT 1`, [c3])).rows;
    await expect(
      pool.query(`INSERT INTO cash_line_bank_attributions (organization_id, company_id, run_id, line_id, journal_entry_id, account_id, account_name, bank_account_id, gl_account_id, classification, rule)
                  SELECT organization_id, company_id, run_id, line_id, journal_entry_id, account_id, account_name, bank_account_id, gl_account_id, classification, rule FROM cash_line_bank_attributions WHERE line_id = $1`, [m.line_id]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("🔴 NO STRAGGLER: reversing an attributed entry after the cut-over gives the mirror the same bank at the moment of reversal; a raw mirror that slipped through is attributed by the next run (A3), and a rerun is a no-op", async () => {
    const t3 = tenant(orgId, c3);
    const jeA = (await pool.query(`SELECT je.id FROM journal_entries je WHERE je.company_id = $1 AND je.entry_number LIKE 'GL-CO-INV-4-PAY-%'`, [c3])).rows[0].id;
    await t3(() => journalEntriesService.reverse(jeA));
    expect(await unattributed(c3), "the mirror carries its bank from the reversal itself").toBe(0);
    const mirror = (await pool.query(`SELECT a.bank_account_id, a.rule, a.run_id FROM cash_line_bank_attributions a JOIN journal_entries je ON je.id = a.journal_entry_id WHERE je.company_id = $1 AND je.entry_number LIKE 'GL-CO-INV-4-PAY-%-REV'`, [c3])).rows[0];
    expect(mirror).toMatchObject({ bank_account_id: c3BankA, rule: "A3_mirror_of_attributed", run_id: null });
    expect((await t3(() => bankAccountsService.getById(c3BankA))).ledgerBalance, "the mirror cancels on the SAME bank").toBe(3000);
    // A straggler: a mirror inserted without an attribution (the race the
    // review named). The header trigger permits it (reversal_of set); the
    // next run attributes it; nothing is stranded, nothing duplicated.
    const orig = (await pool.query(`SELECT je.id FROM journal_entries je WHERE je.company_id = $1 AND je.entry_number LIKE 'TXN-%' AND je.status = 'posted' AND je.reversal_of IS NULL ORDER BY je.id LIMIT 1`, [c3])).rows[0].id;
    const sales = await accountByCode(orgId, "SALES");
    await pool.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [orig]);
    await entry(orgId, c3, "STRAGGLER-REV", "2026-03-20", [{ accountId: sales.id, accountName: sales.name, dr: 3000, cr: 0 }, { accountId: headerId, accountName: "Cash and Bank", dr: 0, cr: 3000 }], { reversalOf: orig });
    expect(await unattributed(c3)).toBe(1);
    const dry = await t3(() => cashCutoverService.dryRun());
    expect(dry.lines).toHaveLength(1);
    expect(dry.lines[0]).toMatchObject({ entryNumber: "STRAGGLER-REV", classification: "DETERMINISTIC", rule: "A3_mirror_of_attributed", knownBankAccountId: c3BankA });
    const digest = await lineDigest();
    const r = await t3(() => cashCutoverService.commit());
    expect(r.state).toBe("committed");
    expect(r.attributed).toBe(1);
    expect(await lineDigest()).toEqual(digest);
    expect(await unattributed(c3)).toBe(0);
    expect((await t3(() => cashCutoverService.commit())).state).toBe("nothing_to_do");
    expect((await pool.query(`SELECT count(*)::int AS n, count(DISTINCT line_id)::int AS d FROM cash_line_bank_attributions WHERE company_id = $1`, [c3])).rows[0]).toEqual({ n: 7, d: 7 });
  });

  it("🔴 ROLLBACK: a failure after the attribution inside the caller's transaction leaves NOTHING — no attribution, no run", async () => {
    const before = await snapshot();
    const conn = await beginTenantConnection({ organizationId: orgId, companyId: c4, role: "authenticated" });
    await expect(
      conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: null }, async () => {
          const r = await cashCutoverService.commit();
          expect(r.attributed).toBe(1);
          throw new Error("simulated failure after the attribution");
        }),
      ).catch(async (err) => { await conn.rollback(); throw err; }),
    ).rejects.toThrow(/simulated/);
    expect(await snapshot()).toEqual(before);
    expect(await unattributed(c4)).toBe(1);
  });

  it("🔴 CONCURRENCY: two commits of the same company at once — one attributes, the other finds nothing to do; exactly one attribution per line, no duplicate, no failure", async () => {
    const run = async () => {
      const conn = await beginTenantConnection({ organizationId: orgId, companyId: c4, role: "authenticated" });
      try {
        const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, () => cashCutoverService.commit()));
        await conn.commit();
        return out;
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    };
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.state, b.state].sort()).toEqual(["committed", "nothing_to_do"]);
    expect(a.attributed + b.attributed).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM cash_line_bank_attributions WHERE company_id = $1`, [c4])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM cash_cutover_runs WHERE company_id = $1 AND mode = 'commit'`, [c4])).rows[0].n).toBe(1);
    expect(await unattributed(c4)).toBe(0);
  });

  it("🔴 A PRE-0073 DRAFT ON THE HEADER cannot be approved into the books (422 account_not_posting) — approval flips status, it inserts no line, so the DB trigger alone could not have caught it", async () => {
    const sales = await accountByCode(orgId, "SALES");
    let draft = 0;
    await withHeaderOpen(orgId, async () => {
      draft = await entry(orgId, c1, "JE-OLD-DRAFT", "2026-03-10", [{ accountId: headerId, accountName: "Cash and Bank", dr: 10, cr: 0 }, { accountId: sales.id, accountName: sales.name, dr: 0, cr: 10 }], { status: "draft" });
    });
    await expect(tenant(orgId, c1)(() => journalEntriesService.approve(draft, userId)))
      .rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "account_not_posting" }) });
    expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [draft])).rows[0].status).toBe("draft");
  });

  it("TENANT ISOLATION: the other organization's dry-run sees only its own line; this organization's runs never touched it", async () => {
    const r = await tenant(otherOrgId, otherCompanyId)(() => cashCutoverService.dryRun());
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.entryNumber).toBe("JE-000001");
    expect(r.lines[0]!.classification).toBe("AMBIGUOUS_REQUIRES_REVIEW");
    expect((await pool.query(`SELECT count(*)::int AS n FROM cash_line_bank_attributions WHERE organization_id = $1`, [otherOrgId])).rows[0].n).toBe(0);
  });
});
