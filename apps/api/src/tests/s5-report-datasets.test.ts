/**
 * 🔴 19B S5 (v4 §14; scope proposal §7.1–§7.3) — THE REMAINING DATASETS, each proven by ONE FIGURE COMPUTED TWO WAYS on
 * rows the product's own paths wrote, non-zero; with movement (one more document moves the figure by exactly its amount)
 * and zero movement for a draft.
 *
 *  - sales_documents:    Σ signed subtotal and VAT  ==  the VAT return's total sales (box 5) and box 6, for the window.
 *                        Amounts are stored positive; the sign is `documentSign()` (a credit note reverses).
 *  - purchase_documents: Σ outstanding  ==  the AP aging's total (billPosition, the one definition of what a bill owes);
 *                        Σ signed subtotal == the return's total purchases (box 12).
 *  - cash_movements:     the bank's lines; the rows that COUNT in income/expense/VAT aggregates (`taxVisible`: accepted,
 *                        operating) == the summary's transaction count and VAT; a transfer is listed and does NOT count.
 *  - vat_lines:          the VAT return's own addends, one row each: Σ by box == every box of the return, and the net.
 *  - the roles (v4 §6.2, D3): a viewer runs journal lines, sales and purchases — never cash movements or VAT lines; the
 *    bookkeeper, the accountant and the admin run all five.
 * DB-backed; skips on the placeholder.
 */
process.env.PORT ??= "3243";
process.env.SESSION_SECRET ??= "s5-report-datasets-000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s5-report-datasets-password-2026";
const h = g04Harness("s5ds");
const WINDOW = "date_from=2026-10-01&date_to=2026-10-31";
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (rows: Array<Record<string, any>>, key: string, pred: (r: Record<string, any>) => boolean = () => true) =>
  r2(rows.filter(pred).reduce((s, r) => s + Number(r[key] ?? 0), 0));

describeDb("19B S5 — sales documents, purchase documents, cash movements and VAT lines", () => {
  let orgId = "";
  let customerId = 0;
  let vendorId = 0;
  let bankId = 0;
  const inv: Record<string, number> = {};
  const bill: Record<string, number> = {};

  const ok = (r: { status: number; text: string; body: any }, status = 200) => { expect(r.status, r.text).toBe(status); return r.body; };
  const rows = async (who: string, dataset: string, qs = WINDOW) => ok(await h.api(who, "GET", `/reports/datasets/${dataset}/rows?${qs}&limit=500`));
  async function invoice(key: string, unitPrice: number, extra: Record<string, unknown> = {}, approve = true) {
    const d = ok(await h.api("admin", "POST", "/invoices", { date: "2026-10-05", dueDate: "2026-10-31", customerId, items: [{ description: `S5 ${key}`, quantity: 1, unitPrice, vatRate: 15 }], ...extra }), 201);
    inv[key] = d.id;
    if (approve) { ok(await h.api("admin", "POST", `/invoices/${d.id}/submit`)); ok(await h.api("admin", "POST", `/invoices/${d.id}/approve`)); }
  }
  async function purchase(key: string, subtotal: number, post = true) {
    const vat = r2(subtotal * 0.15);
    const d = ok(await h.api("admin", "POST", "/bills", { date: "2026-10-06", vendorId, vendorReference: `S5-${key}`, supplierDocumentKind: "tax_invoice", subtotal, vatAmount: vat, total: r2(subtotal + vat), items: [] }), 201);
    bill[key] = d.id;
    if (post) ok(await h.api("admin", "POST", `/bills/${d.id}/post`, {}));
  }
  const vatReturn = async () => ok(await h.api("admin", "GET", "/reports/vat-return?period_from=2026-10&period_to=2026-10"));

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S5 Dataset Co", "319898989898983");
    for (const role of ROLES) await h.mkUser(role, PW, orgId, role);
    for (const role of ROLES) expect(await h.login(role, h.email(role), PW)).toBe(200);
    customerId = ok(await h.api("admin", "POST", "/customers", { name: "S5 walk-in" }), 201).id;
    vendorId = ok(await h.api("admin", "POST", "/vendors", { name: "S5 Supplier", taxNumber: "300000000000003" }), 201).id;
    bankId = ok(await h.api("admin", "POST", "/bank-accounts", { name: "S5 Ops", bankName: "SNB", currency: "SAR" }), 201).id;
    await invoice("a", 1000);
    await invoice("b", 400);
    await invoice("cn", 200, { documentType: "credit_note", originalInvoiceId: inv.a, noteReason: "Price correction" });
    await invoice("draft", 999, {}, false);
    await purchase("x", 500);
    await purchase("y", 300);
    await purchase("draft", 777, false);
    ok(await h.api("admin", "POST", `/bills/${bill.x}/pay`, { amount: 115, paidAt: "2026-10-20", bankAccountId: bankId }));
    const acct = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
    ok(await h.api("admin", "POST", "/transactions", { date: "2026-10-10", description: "S5 BANK RENT", amount: 115, vatAmount: 15, currency: "SAR", type: "debit", categoryId: await acct("RENT_UTILITIES"), bankAccountId: bankId }), 201);
    ok(await h.api("admin", "POST", "/transactions", { date: "2026-10-11", description: "S5 BANK FEES IN", amount: 230, vatAmount: 30, currency: "SAR", type: "credit", categoryId: await acct("SERVICE_INCOME"), bankAccountId: bankId }), 201);
    // a transfer: listed as a cash movement, never counted in an income, expense or VAT aggregate
    await pool.query(
      `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, kind, review_status, bank_account_id)
       SELECT $1, c.id, '2026-10-12', 'S5 ATM WITHDRAWAL', '1000.00', 'debit', 'transfer', 'accepted', $2 FROM companies c WHERE c.organization_id = $1`,
      [orgId, bankId],
    );
  }, 180_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  it("🔴 the roles: a viewer runs sales and purchases, never cash movements or VAT lines; the other roles run all five", async () => {
    const names = (who: string) => h.api(who, "GET", "/reports/datasets").then((r) => (ok(r).items as Array<{ name: string }>).map((i) => i.name).sort());
    expect(await names("viewer")).toEqual(["journal_lines", "purchase_documents", "sales_documents"]);
    for (const who of ["admin", "accountant", "bookkeeper"]) expect([who, await names(who)]).toEqual([who, ["cash_movements", "journal_lines", "purchase_documents", "sales_documents", "vat_lines"]]);
    for (const ds of ["cash_movements", "vat_lines"]) {
      const r = await h.api("viewer", "GET", `/reports/datasets/${ds}/rows?${WINDOW}`);
      expect([ds, r.status, r.body.code]).toEqual([ds, 403, "report_dataset_not_granted"]);
      expect([ds, (await h.api("viewer", "GET", `/reports/datasets/${ds}/export?${WINDOW}`)).status]).toEqual([ds, 403]);
    }
    for (const ds of ["sales_documents", "purchase_documents"]) expect([ds, (await h.api("viewer", "GET", `/reports/datasets/${ds}/rows?${WINDOW}`)).status]).toEqual([ds, 200]);
  });

  it("🔴 sales documents: Σ signed subtotal and VAT equal the VAT return's total sales and box 6 — a credit note reverses, a draft moves nothing, one more invoice moves it by exactly its amount", async () => {
    const d = await rows("viewer", "sales_documents");
    const ret = await vatReturn();
    expect(d.total).toBe(3); // the draft is not in the books
    expect(d.rows.map((r: any) => [r.documentType, r.subtotal, r.sign]).sort()).toEqual([["credit_note", 200, -1], ["invoice", 1000, 1], ["invoice", 400, 1]].sort());
    expect(d.rows.every((r: any) => r.subtotal > 0 && r.vatAmount > 0)).toBe(true); // stored positive; the direction is the type's
    expect(sum(d.rows, "signedSubtotal")).toBe(1200);
    expect([sum(d.rows, "signedSubtotal"), sum(d.rows, "signedVat")]).toEqual([ret.salesSection.box5_totalSales, ret.salesSection.box6_vatOnStandardRatedSales]);
    await invoice("c", 250);
    const after = await rows("viewer", "sales_documents");
    expect([sum(after.rows, "signedSubtotal"), sum(after.rows, "signedVat")]).toEqual([1450, r2(180 + 37.5)]);
    expect(sum(after.rows, "signedSubtotal")).toBe((await vatReturn()).salesSection.box5_totalSales);
  });

  it("🔴 purchase documents: Σ outstanding equals the AP aging's total (a part payment counted), Σ signed subtotal the return's purchases; a draft moves nothing", async () => {
    const d = await rows("viewer", "purchase_documents");
    const aging = ok(await h.api("admin", "GET", "/reports/ap-aging"));
    expect(d.total).toBe(2);
    expect(sum(d.rows, "outstanding")).toBe(r2(575 - 115 + 345));
    expect(sum(d.rows, "outstanding")).toBe(aging.total);
    expect(sum(d.rows, "signedSubtotal")).toBe((await vatReturn()).purchasesSection.box12_totalPurchases);
    // movement: one more payment moves the outstanding by exactly its amount, in both paths
    ok(await h.api("admin", "POST", `/bills/${bill.y}/pay`, { amount: 45, paidAt: "2026-10-21", bankAccountId: bankId }));
    const after = await rows("viewer", "purchase_documents");
    expect(sum(after.rows, "outstanding")).toBe(r2(805 - 45));
    expect(sum(after.rows, "outstanding")).toBe(ok(await h.api("admin", "GET", "/reports/ap-aging")).total);
  });

  it("🔴 cash movements: the rows that count in aggregates equal the summary's count and VAT; the transfer is listed and does not count", async () => {
    const d = await rows("bookkeeper", "cash_movements");
    const summary = ok(await h.api("admin", "GET", `/summary?${WINDOW}`));
    expect(d.total).toBe(3);
    const counted = d.rows.filter((r: any) => r.countsInAggregates);
    expect(counted.length).toBe(2);
    expect(counted.length).toBe(summary.transactionCount);
    expect([sum(counted, "vatAmount", (r) => r.type === "credit"), sum(counted, "vatAmount", (r) => r.type === "debit")]).toEqual([summary.totalVatCollected, summary.totalVatPaid]);
    const transfer = d.rows.find((r: any) => r.kind === "transfer");
    expect([transfer.description, transfer.amount, transfer.countsInAggregates]).toEqual(["S5 ATM WITHDRAWAL", 1000, false]);
    expect(sum(d.rows, "signedAmount")).toBe(r2(230 - 115 - 1000)); // money in is positive, money out negative
  });

  it("🔴 VAT lines: the return's own addends — Σ by box equals every box of the return, and the net", async () => {
    const d = await rows("accountant", "vat_lines");
    const ret = await vatReturn();
    const box = (key: "taxableBox" | "vatBox", n: number, value: "taxable" | "vat") => sum(d.rows, value, (r) => r[key] === n);
    expect(box("taxableBox", 1, "taxable")).toBeGreaterThan(0);
    expect([box("taxableBox", 1, "taxable"), box("taxableBox", 2, "taxable"), box("taxableBox", 3, "taxable")]).toEqual(
      [ret.salesSection.box1_standardRatedDomesticSales, ret.salesSection.box2_zeroRatedDomesticSales, ret.salesSection.box3_exemptSales]);
    expect([box("vatBox", 6, "vat"), box("vatBox", 7, "vat")]).toEqual([ret.salesSection.box6_vatOnStandardRatedSales, ret.salesSection.box7_vatAdjustments]);
    expect([box("taxableBox", 9, "taxable"), box("taxableBox", 10, "taxable"), box("vatBox", 13, "vat")]).toEqual(
      [ret.purchasesSection.box9_standardRatedPurchases, ret.purchasesSection.box10_zeroRatedPurchases, ret.purchasesSection.box13_recoverableInputVat]);
    expect(box("vatBox", 13, "vat")).toBe(120);
    expect(r2(box("vatBox", 6, "vat") + box("vatBox", 7, "vat") - box("vatBox", 13, "vat"))).toBe(ret.netVatDue);
    // the window is the return's: without one the dataset is refused, never guessed
    const none = await h.api("accountant", "GET", "/reports/datasets/vat_lines/rows");
    expect([none.status, none.body.code]).toEqual([400, "report_bad_filter"]);
  });

  it("🔴 the export of each: a CSV of the same rows for a role that may; recorded in the audit trail", async () => {
    for (const ds of ["sales_documents", "purchase_documents", "cash_movements", "vat_lines"]) {
      const r = await h.api("admin", "GET", `/reports/datasets/${ds}/export?${WINDOW}&lang=en`);
      expect([ds, r.status]).toEqual([ds, 200]);
      expect([ds, r.text.split("\n").length > 2]).toEqual([ds, true]);
    }
    const recorded = (await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE organization_id = $1 AND action = 'export'`, [orgId])).rows[0].n;
    expect(recorded).toBeGreaterThanOrEqual(4);
  });
});
