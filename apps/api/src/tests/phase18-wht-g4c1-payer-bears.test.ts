/**
 * 🔴 Phase 18 G4c-1 — WHT: owner decision 15, the payer bears the tax (register
 * §11.30; final-run memo §2 G; scoped D-4 statement register §11.44, appended
 * before this file). DECIDED 2026-10-27: an owner decision based on research,
 * not a professional opinion; reversible; to be reviewed before go-live. It
 * answers open question W-2.
 *
 *  - a per-contract setting, confirmed by the user: "net-of-tax, payer bears
 *    WHT" (gross = net ÷ (1 − rate), WHT on the gross) or "tax-inclusive" (no
 *    gross-up);
 *  - under a net-of-tax contract the supplier receives the full amount and the
 *    company bears the tax as an expense (WHT_BORNE_EXPENSE);
 *  - borne WHT is not deductible for income tax (Law Art. 13(e); Regulations
 *    Art. 10(5)): added back as its own step.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3251";
process.env.SESSION_SECRET ??= "phase18-wht-g4c1-borne-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18WhtG4c1Pw1!";

describeMaybe("Phase 18 G4c-1 — the payer bears the WHT: the per-contract gross-up (decision 15)", () => {
  const h = g04Harness("p18whtg4c1");
  const today = businessToday();
  let orgId = "", bankId = 0, vendorId = 0, otherVendorId = 0, residentId = 0, netContract = 0, inclusiveContract = 0, seq = 0;

  const contract = (body: Record<string, unknown>) => h.api("admin", "POST", "/tax/wht/contracts", {
    vendorId, reference: `LA-${++seq}`, taxBearing: "net_of_tax", confirmed: true, ...body,
  });
  const payBill = async (amount: number, paidAt: string, extra: Record<string, unknown> = {}, vendor = vendorId) => {
    seq += 1;
    const bill = await h.api("admin", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: `G4C1-R-${seq}`, billNumber: `G4C1-${seq}`, date: paidAt, dueDate: paidAt, vendorId: vendor,
      items: [{ description: "Consulting", quantity: 1, unitPrice: amount, vatRate: 0 }] });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    expect((await h.api("admin", "POST", `/bills/${bill.body.id}/approve`, {})).status).toBe(200);
    const paid = await h.api("admin", "POST", `/bills/${bill.body.id}/pay`, { amount, paidAt, bankAccountId: bankId, ...extra });
    return { paid, billId: bill.body.id as number };
  };
  /** The entry's lines by account: the system code, or BANK for a bank's own leaf. */
  const linesOf = async (entryId: number) => (await pool.query(
    `SELECT coalesce(c.system_code, CASE WHEN c.bank_account_id IS NOT NULL THEN 'BANK' END) AS code, l.debit_amount::float AS dr, l.credit_amount::float AS cr
       FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.id`, [entryId])).rows;
  const withholdingOfBill = async (billId: number) => (await pool.query(
    `SELECT base_amount::float AS base, wht_amount::float AS wht, journal_entry_id FROM wht_withholdings WHERE bill_id = $1`, [billId])).rows[0];
  const bearingOf = async (where: string, id: number) => (await pool.query(
    `SELECT base_amount::float AS base, wht_amount::float AS wht, net_amount::float AS net, tax_bearing, contract_id, journal_entry_id FROM wht_withholdings WHERE ${where} = $1`, [id])).rows[0];

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    // FOREIGN-owned: income tax applies to the whole of the taxable income (Art. 2(a)) — the add-back case reads it
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type, foreign_ownership_pct) VALUES ($1,'G4c1 Co',1,'gregorian','399999999999993','1010303031','FOREIGN',100)`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    bankId = (await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" })).body.id;
    const mk = async (name: string, residency: string) => {
      const v = await h.api("admin", "POST", "/vendors", { name, residency, ...(residency === "non_resident" ? { whtDefaultPaymentType: "technical_consulting", country: "GB" } : {}) });
      expect(v.status, JSON.stringify(v.body)).toBe(201);
      return v.body.id as number;
    };
    vendorId = await mk("G4c1 London Advisory", "non_resident");
    otherVendorId = await mk("G4c1 Paris Advisory", "non_resident");
    residentId = await mk("G4c1 Riyadh Supplies", "resident");
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 15: a contract's tax-bearing setting is recorded per supplier — only with the user's explicit confirmation, only for a non-resident", async () => {
    const unconfirmed = await contract({ confirmed: false });
    expect([unconfirmed.status, unconfirmed.body.code]).toEqual([422, "wht_contract_confirmation_required"]);
    const resident = await contract({ vendorId: residentId });
    expect([resident.status, resident.body.code]).toEqual([422, "wht_contract_vendor_not_non_resident"]);
    const net = await contract({ reference: "LA-NET" });
    expect(net.status, JSON.stringify(net.body)).toBe(201);
    expect(net.body).toMatchObject({ vendorId, reference: "LA-NET", taxBearing: "net_of_tax" });
    netContract = net.body.id;
    const inclusive = await contract({ reference: "LA-INC", taxBearing: "tax_inclusive" });
    expect(inclusive.status, JSON.stringify(inclusive.body)).toBe(201);
    inclusiveContract = inclusive.body.id;
    const list = await h.api("admin", "GET", `/tax/wht/contracts?vendorId=${vendorId}`);
    expect(list.status).toBe(200);
    expect((list.body as { id: number; taxBearing: string }[]).map((c) => [c.id, c.taxBearing]).sort()).toEqual([[netContract, "net_of_tax"], [inclusiveContract, "tax_inclusive"]].sort());
  });

  it("🔴 15: a payment under a NET-OF-TAX contract is grossed up — base = net ÷ (1 − rate), the supplier receives the full amount, the company bears the tax as an expense", async () => {
    const { paid, billId } = await payBill(1_000, today, { whtContractId: netContract });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const w = await bearingOf("bill_id", billId);
    // technical services, 5 %: gross = 1,000 ÷ 0.95 = 1,052.63; tax = 5 % of the gross = 52.63
    expect(w).toMatchObject({ base: 1_052.63, wht: 52.63, net: 1_000, tax_bearing: "net_of_tax", contract_id: netContract });
    expect(await linesOf(w.journal_entry_id)).toEqual([
      { code: "AP", dr: 1_000, cr: 0 },
      { code: "BANK", dr: 0, cr: 1_000 },
      { code: "WHT_PAYABLE", dr: 0, cr: 52.63 },
      { code: "WHT_BORNE_EXPENSE", dr: 52.63, cr: 0 },
    ]);
    // the month's return reports the GROSS base
    const ret = await h.api("admin", "GET", `/tax/wht/returns/${today.slice(0, 7)}`);
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    expect((ret.body.schedule as { baseAmount: number; whtAmount: number }[]).some((s) => s.baseAmount === 1_052.63 && s.whtAmount === 52.63)).toBe(true);
  });

  it("control: a payment naming NO contract is not grossed up — base = the amount, the supplier bears the tax, no borne-tax expense", async () => {
    const { paid, billId } = await payBill(1_000, today);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const w = await withholdingOfBill(billId);
    expect([w.base, w.wht]).toEqual([1_000, 50]);
    expect(await linesOf(w.journal_entry_id)).toEqual([
      { code: "AP", dr: 1_000, cr: 0 },
      { code: "BANK", dr: 0, cr: 950 },
      { code: "WHT_PAYABLE", dr: 0, cr: 50 },
    ]);
  });

  it("🔴 15: a TAX-INCLUSIVE contract is not grossed up either — and the withholding records the contract it was paid under", async () => {
    const { paid, billId } = await payBill(1_000, today, { whtContractId: inclusiveContract });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const w = await bearingOf("bill_id", billId);
    expect(w).toMatchObject({ base: 1_000, wht: 50, net: null, tax_bearing: "tax_inclusive", contract_id: inclusiveContract });
    expect((await linesOf(w.journal_entry_id)).map((l) => l.code)).toEqual(["AP", "BANK", "WHT_PAYABLE"]);
  });

  it("🔴 15: another supplier's contract is refused by name — nothing is written", async () => {
    const before = (await pool.query(`SELECT count(*)::int n FROM bill_payments WHERE organization_id = $1`, [orgId])).rows[0].n;
    const { paid } = await payBill(400, today, { whtContractId: netContract }, otherVendorId);
    expect([paid.status, paid.body.code]).toEqual([422, "wht_contract_vendor_mismatch"]);
    expect((await pool.query(`SELECT count(*)::int n FROM bill_payments WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(before);
  });

  it("🔴 15: the supplier-payment path grosses up the same way", async () => {
    const sp = await h.api("admin", "POST", "/supplier-payments", { vendorId, bankAccountId: bankId, amount: 2_000, paidAt: today, classification: "advance", whtContractId: netContract });
    expect(sp.status, JSON.stringify(sp.body)).toBe(201);
    const w = await bearingOf("supplier_payment_id", sp.body.id);
    // 2,000 ÷ 0.95 = 2,105.26; 5 % of it = 105.26
    expect(w).toMatchObject({ base: 2_105.26, wht: 105.26, net: 2_000, tax_bearing: "net_of_tax", contract_id: netContract });
    const lines = await linesOf(w.journal_entry_id);
    expect(lines.find((l) => l.code === "BANK")).toEqual({ code: "BANK", dr: 0, cr: 2_000 });
    expect(lines.find((l) => l.code === "WHT_BORNE_EXPENSE")).toEqual({ code: "WHT_BORNE_EXPENSE", dr: 105.26, cr: 0 });
  });

  it("🔴 15: the preview shows the gross-up before the payment is made", async () => {
    const p = await h.api("admin", "GET", `/tax/wht/preview?vendorId=${vendorId}&amount=1000&date=${today}&whtContractId=${netContract}`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ kind: "withheld", base: 1_052.63, withheld: 52.63, cashPaid: 1_000, taxBearing: "net_of_tax" });
  });

  it("🔴 15: borne WHT is NOT deductible for income tax — added back as its own step (Law Art. 13(e)); tax the supplier bore is not", async () => {
    for (const g of [1, 2, 3, 4, 5]) {
      const d = await h.api("admin", "POST", "/assets/income-tax-pool/declarations", { incomeTaxGroup: g, taxYear: 2024, closingBalanceDeclared: 0, additionsDeclared: 0, disposalsDeclared: 0 });
      expect(d.status, JSON.stringify(d.body)).toBe(200);
    }
    expect((await payBill(3_000, "2025-03-10", { whtContractId: netContract })).paid.status).toBe(200); // borne: 3,000 ÷ 0.95 = 3,157.89 → 157.89
    expect((await payBill(2_000, "2025-04-10", { whtContractId: inclusiveContract })).paid.status).toBe(200); // the supplier bears 100
    const c = await h.api("admin", "POST", "/tax/computations", { kind: "income_tax", fiscalYearLabel: 2025 });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const d = await h.api("admin", "GET", `/tax/computations/${c.body.id}`);
    expect(d.status).toBe(200);
    const it1 = d.body.live.incomeTax;
    expect(d.body.live.blockers, JSON.stringify(d.body.live.blockers)).toEqual([]);
    expect(it1.steps.find((s: { key: string }) => s.key === "borne_wht")).toEqual({ key: "borne_wht", article: "13(e)", amount: 157.89 });
    expect(it1.borneWhtAddBack).toBe(157.89);
    // the year's expenses: 3,000 + 2,000 consulting and 157.89 borne → profit −5,157.89; taxable = −5,157.89 + 157.89
    expect([it1.profitBeforeTaxes, it1.taxableIncome]).toEqual([-5_157.89, -5_000]);
  });
});
