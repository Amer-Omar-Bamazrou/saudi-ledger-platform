/**
 * 🔴 Phase 18 audit (2026-11-09), finding A4 — G36's "round at the gate": a request amount is ONE value.
 *
 * G36's control was "C-IDEM; lock before read; round at the gate". The third part was not built: `bills.payment.ts`
 * (and nine sibling services) parsed `Number(amount)` and used it unrounded. For 1.005, JavaScript's money seam rounds
 * to 1.00 (the double is 1.00499…) while Postgres's numeric column rounds the text "1.005" to 1.01 — so a 1.01 bill
 * paid 1.005 read PAID, with paid_amount 1.00, a payment row of 1.01 and an AP debit of 1.00: a halala left in AP on
 * a bill the product says is settled. The existing proof (phase18-s1b-g36-bill-pay.test.ts) pays 100.005, the one
 * kind of value on which both roundings agree (100.005 × 100 is exactly 10000.5), so it could not see this.
 *
 * Now every request amount is parsed by `moneyInput` (lib/money.ts); a source ratchet refuses a bare parse.
 * DB-backed (sl_test / CI); the ratchet runs everywhere.
 */
process.env.PORT ??= "3393";
process.env.SESSION_SECRET ??= "phase18-audit-a4-money-at-the-gate-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { BILL_OUTSTANDING_TEXT } from "../repositories/billPosition";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA4MoneyGatePw123!";
const twoDp = (n: number) => Math.round(n * 100) / 100 === n;

describe("Phase 18 audit A4 — the source ratchet: no service parses a request amount without the money seam", () => {
  const SERVICES = fileURLToPath(new URL("../services", import.meta.url));
  /** A bare parse of an amount: `= Number(amount)`, `= Number(body.amount)`, `= Number(p.amount)` … */
  const BARE = /=\s*Number\(\s*(?:[A-Za-z_$][\w$]*\.)*amount\s*\)/g;
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) ? [p] : [];
  });

  it("the detector sees the shape it refuses (known-present) and not its fix (known-absent)", () => {
    expect("    const paid = Number(amount);".match(BARE)).toHaveLength(1);
    expect("    const amount = Number(body.amount);".match(BARE)).toHaveLength(1);
    expect("    const paid = moneyInput(amount);".match(BARE)).toBeNull();
    expect("    const n = Number(body.count);".match(BARE)).toBeNull();
  });

  it("🔴 every request amount in services goes through moneyInput — none is parsed bare", () => {
    const all = files(SERVICES);
    expect(all.length, "the walk found the services").toBeGreaterThan(50);
    const bare = all.flatMap((f) => (readFileSync(f, "utf8").match(BARE) ?? []).map((m) => `${f.slice(SERVICES.length + 1)}: ${m.trim()}`));
    expect(bare).toEqual([]);
    const uses = all.reduce((s, f) => s + (readFileSync(f, "utf8").match(/\bmoneyInput\(/g) ?? []).length, 0);
    expect(uses, "presence: the seam is used at every site it replaced").toBeGreaterThanOrEqual(17);
  });
});

describeMaybe("Phase 18 audit A4 — a sub-halala payment is one value everywhere it is recorded", () => {
  const h = g04Harness("auda4");
  let orgId = "", vendorId = 0, customerId = 0, bankId = 0;

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit A4 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'A4 Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'A4 Buyer') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "A4 Bank", bankName: "Al Rajhi", currency: "SAR", openingBalance: 1000 });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id;
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a 1.01 bill paid 1.005: the payment row, paid_amount and the AP debit are one 2-dp value, and 'paid' means nothing is owed", async () => {
    const created = await h.api("admin", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: "A4-B1-SUP", billNumber: "A4-B1", date: "2026-10-01", dueDate: "2026-10-31", vendorId,
      items: [{ description: "Supplies", quantity: 1, unitPrice: 0.88, vatRate: 15 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await h.api("admin", "POST", `/bills/${created.body.id}/approve`, {})).status).toBe(200);
    const id = created.body.id as number;
    expect(Number((await pool.query(`SELECT total FROM bills WHERE id = $1`, [id])).rows[0].total), "the fixture: a 1.01 bill").toBe(1.01);

    const r = await h.api("admin", "POST", `/bills/${id}/pay`, { amount: 1.005, paidAt: "2026-10-10", bankAccountId: bankId });
    const row = (await pool.query(`SELECT paid_amount::float AS paid, status, (${BILL_OUTSTANDING_TEXT("b")})::float AS outstanding FROM bills b WHERE b.id = $1`, [id])).rows[0];
    const payments = (await pool.query(`SELECT amount::float AS a FROM bill_payments WHERE bill_id = $1`, [id])).rows.map((x) => x.a as number);
    const apDebits = Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount), 0)::float AS d FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN categories c ON c.id = l.account_id WHERE e.organization_id = $1 AND c.system_code = 'AP' AND e.entry_number LIKE 'BILL-A4-B1-PAY-%'`, [orgId])).rows[0].d);
    if (r.status >= 400) {
      expect([payments.length, row.paid], `a refused payment writes nothing: ${JSON.stringify(r.body)}`).toEqual([0, 0]);
      return;
    }
    const sum = Math.round(payments.reduce((s, a) => s + a, 0) * 100) / 100;
    expect([twoDp(row.paid), twoDp(sum), twoDp(apDebits)], "every stored figure at 2 dp").toEqual([true, true, true]);
    expect(row.paid, "paid_amount = the payment row").toBe(sum);
    expect(apDebits, "the AP debit = the payment row").toBe(sum);
    if (row.status === "paid") expect(row.outstanding, "a bill read PAID owes nothing").toBe(0);
  }, 60_000);

  it("🔴 a 1.01 invoice paid 1.005: the receipt, its allocation and paid_amount are one 2-dp value, and 'paid' means nothing is owed", async () => {
    const inv = await h.api("admin", "POST", "/invoices", { customerId, date: "2026-10-01", items: [{ description: "Service", quantity: 1, unitPrice: 0.88, vatRate: 15 }] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await h.api("admin", "POST", `/invoices/${inv.body.id}/approve`, {})).status).toBe(200);
    const id = inv.body.id as number;
    expect(Number((await pool.query(`SELECT total FROM invoices WHERE id = $1`, [id])).rows[0].total), "the fixture: a 1.01 invoice").toBe(1.01);

    const r = await h.api("admin", "POST", `/invoices/${id}/pay`, { amount: 1.005, paidAt: "2026-10-10", bankAccountId: bankId });
    const row = (await pool.query(`SELECT paid_amount::float AS paid, status, total::float AS total, credited_amount::float AS credited, written_off_amount::float AS wo FROM invoices WHERE id = $1`, [id])).rows[0];
    const allocs = (await pool.query(`SELECT a.amount::float AS a, p.amount::float AS p FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = $1`, [id])).rows as Array<{ a: number; p: number }>;
    if (r.status >= 400) {
      expect([allocs.length, row.paid], `a refused payment writes nothing: ${JSON.stringify(r.body)}`).toEqual([0, 0]);
      return;
    }
    expect(allocs).toHaveLength(1);
    expect([twoDp(row.paid), twoDp(allocs[0]!.a), twoDp(allocs[0]!.p)], "every stored figure at 2 dp").toEqual([true, true, true]);
    expect(allocs[0]!.p, "the receipt = its allocation").toBe(allocs[0]!.a);
    expect(row.paid, "paid_amount = the allocation").toBe(allocs[0]!.a);
    const outstanding = Math.round((row.total - row.credited - row.wo - row.paid) * 100) / 100;
    if (row.status === "paid") expect(outstanding, "an invoice read PAID owes nothing").toBe(0);
  }, 60_000);
});
