/**
 * 🔴 G04 SAME-CLASS SWEEP (2026-10-07) — every request-body id the
 * investigation exercised, held as a REGRESSION: no endpoint stores a reference
 * to another tenant's row (or, where the target is company-scoped, to the same
 * organization's other company), and a nonexistent id is a controlled 4xx.
 *
 * The investigation (docs/security-g04-cross-tenant-account-investigation.md
 * §7) found four of these vulnerable on unmodified main: the journal line's
 * account (G04 itself — its own suite, `g04-journal-line-references`), the
 * invoice line's product, the asset's custodian, and the bill's asset to
 * capitalise. The rest were safe, and this file keeps them so.
 *
 * Each case, in order:
 *   1. CONTROL — the request with the tenant's OWN id must succeed. A control
 *      that fails is a FAILURE here, not a skip: a regression suite whose
 *      control cannot run proves nothing (the investigation's one unprovable
 *      row — settling a bank line against a bill — now plants a genuinely
 *      pending statement line, which is what its control was missing).
 *   2. FOREIGN — another TENANT's id, and for a company-scoped target the
 *      same organization's OTHER COMPANY's id: refused (4xx), with no new
 *      cross-scope reference in the catalog and none in the per-case check.
 *   3. MISSING — an id that exists nowhere: the same status as the foreign
 *      one, never a 5xx; for the four fixed columns, the IDENTICAL body.
 *
 * The detector reads every single-column foreign key between two tenant
 * tables. The four fixed columns now carry composite keys (migration 0122), so
 * the database itself cannot hold the edge — and each still has a per-case
 * `stored` check, so this file does not depend on that to see one.
 */
process.env.PORT ??= "3125";
process.env.SESSION_SECRET ??= "g04-cross-tenant-references-sweep-secret-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { bankAccountsService } from "../services/bankAccounts.service";
import { invoicesService } from "../services/invoices.service";
import { assetsService } from "../services/assets.service";
import { g04Harness, type Res } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G04SweepPw1!";
const MISSING = 2_000_000_000;
const TODAY = new Date().toISOString().slice(0, 10);

type Who = "x" | "y";
type Id = number | string;
type Case = {
  name: string; endpoint: string; field: string; scope: "tenant" | "tenant+company";
  own: () => Promise<Id>; foreign: () => Promise<Id>; otherCompany?: () => Promise<Id>;
  missing?: Id;
  send: (value: Id) => Promise<Res>;
  /** Did the write land a reference to `value` in X's rows? (no-FK columns, composite-key columns, other-tenant writes) */
  stored?: (value: Id) => Promise<boolean>;
  /** A bulk act that answers 2xx with nothing done: judged by `stored` alone. */
  judgeByEffectOnly?: boolean;
  /** One of the columns G04 fixed: the missing id's refusal must be byte-identical to the foreign one's. */
  fixed?: boolean;
};

describeMaybe("G04 sweep — ids from the request body never reach across tenants or companies", () => {
  const h = g04Harness("g04s");
  const { api, inTenant } = h;
  const org: Record<string, string> = {};
  const co: Record<string, string> = {};
  const uid: Record<string, number> = {};
  let n = 0;
  const next = () => ++n;
  let edgeSql = "";
  const fx: Record<string, any> = {};

  const ok = (r: Res, what: string) => {
    if (r.status < 200 || r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  };
  const inX2 = <T,>(fn: () => Promise<T>) => inTenant(org.x, co.x2, uid.x, fn);
  const sys = async (who: Who, code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [org[who], code])).rows[0].id as number;

  /** Every cross-tenant / cross-company reference held by rows of org X, over the single-column tenant keys. */
  async function crossEdges(): Promise<Record<string, number>> {
    const rows = (await pool.query(edgeSql, [org.x])).rows as { e: string; org_n: number; co_n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (r.org_n) out[`${r.e} → other tenant`] = r.org_n;
      if (r.co_n) out[`${r.e} → other company`] = r.co_n;
    }
    return out;
  }
  const delta = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== (a[k] ?? 0)).map(([k, v]) => [k, v - (a[k] ?? 0)]));

  // ── prerequisites ──────────────────────────────────────────────────────────
  const mkBank = async (who: Who) => ok(await api(who, "POST", "/bank-accounts", { name: `B${next()}`, bankName: "Bank", currency: "SAR", balance: 0, openingBalance: 0 }), "bank").id as number;
  const mkCustomer = async (who: Who) => ok(await api(who, "POST", "/customers", { name: `C${next()}` }), "customer").id as number;
  const mkVendor = async (who: Who) => ok(await api(who, "POST", "/vendors", { name: `V${next()}`, residency: "resident" }), "vendor").id as number;
  const mkInvoice = async (who: Who, customerId: number) => {
    const inv = ok(await api(who, "POST", "/invoices", { invoiceNumber: `I${next()}`, date: TODAY, customerId, items: [{ description: "S", quantity: 1, unitPrice: 1000, vatRate: 15 }] }), "invoice");
    ok(await api(who, "POST", `/invoices/${inv.id}/approve`, {}), "invoice approve");
    return inv.id as number;
  };
  const billBody = (vendorId: number, extra: Record<string, unknown> = {}) => ({
    supplierDocumentKind: "tax_invoice", vendorReference: `VR${next()}`, billNumber: `BL${next()}`, date: TODAY, dueDate: TODAY, vendorId,
    items: [{ description: "Supply", quantity: 1, unitPrice: 1000, vatRate: 0 }], ...extra,
  });
  const mkBill = async (who: Who, vendorId: number) => {
    const b = ok(await api(who, "POST", "/bills", billBody(vendorId)), "bill");
    ok(await api(who, "POST", `/bills/${b.id}/approve`, {}), "bill approve");
    return b.id as number;
  };
  const mkAssetCategory = async (who: Who) =>
    ok(await api(who, "POST", "/asset-categories", { name: `AC${next()}`, defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }), "asset category").id as number;
  const mkAsset = async (who: Who, categoryId: number) =>
    ok(await api(who, "POST", "/assets", { name: `A${next()}`, categoryId, acquisitionDate: TODAY, cost: 1000 }), "asset").id as number;
  const mkTxn = async (who: Who, type: "debit" | "credit", amount: number, extra: Record<string, unknown> = {}) =>
    ok(await api(who, "POST", "/transactions", { date: TODAY, description: `T${next()}`, amount, currency: "SAR", type, bankAccountId: fx[who].bank, ...extra }), "txn").id as number;
  /**
   * A statement line awaiting review that has posted NOTHING — the state an
   * IMPORTED line arrives in. Planted (stand-in for the importer); the settle
   * endpoint is what is tested. On a fresh bank, so no earlier reconciliation
   * lock reaches it.
   */
  const plantPendingLine = async (type: "debit" | "credit", amount: number) => {
    const bank = await mkBank("x");
    return (await pool.query(
      `INSERT INTO transactions (organization_id, company_id, date, description, amount, currency, type, source, review_status, bank_account_id)
       VALUES ($1,$2,$3,$4,$5,'SAR',$6,'csv','pending_review',$7) RETURNING id`,
      [org.x, co.x1, TODAY, `PENDING ${next()}`, amount, type, bank])).rows[0].id as number;
  };
  const plantCapture = async (who: Who) =>
    (await pool.query(`INSERT INTO captured_documents (organization_id, company_id, content_type, byte_size, sha256, source) VALUES ($1,$2,'application/pdf',10,$3,'upload') RETURNING id`,
      [org[who], who === "x" ? co.x1 : co.y1, randomUUID().replace(/-/g, "")])).rows[0].id as string;
  const draftInvoice = async () =>
    ok(await api("x", "POST", "/invoices", { invoiceNumber: `D${next()}`, date: TODAY, customerId: fx.x.customer, items: [{ description: "S", quantity: 1, unitPrice: 10, vatRate: 15 }] }), "draft").id as number;

  const CASES: Case[] = [];
  const add = (c: Case) => CASES.push(c);

  // ── accounts (organization-scoped) ─────────────────────────────────────────
  add({ name: "budget line account", endpoint: "PUT /budgets/{id}/versions/{vid}/lines", field: "lines[].accountId", scope: "tenant",
    own: async () => fx.x.expense, foreign: async () => fx.y.expense,
    send: async (v) => {
      const b = ok(await api("x", "POST", "/budgets", { name: `Bud${next()}`, fiscalYearLabel: 2026 }), "budget");
      return api("x", "PUT", `/budgets/${b.id}/versions/${b.version.id}/lines`, { lines: [{ accountId: v, periods: Array(12).fill(100) }] });
    } });
  add({ name: "asset category cost account", endpoint: "POST /asset-categories", field: "costAccountId", scope: "tenant",
    own: async () => fx.x.fixedAssets, foreign: async () => fx.y.fixedAssets,
    send: (v) => api("x", "POST", "/asset-categories", { name: `AC${next()}`, defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable", costAccountId: v, accumulatedDepreciationAccountId: fx.x.accum, depreciationExpenseAccountId: fx.x.deprExp }) });
  add({ name: "bill expense account (create + approve posts it)", endpoint: "POST /bills", field: "expenseAccountId", scope: "tenant",
    own: async () => fx.x.expense, foreign: async () => fx.y.expense,
    send: async (v) => {
      const b = await api("x", "POST", "/bills", billBody(fx.x.vendor, { expenseAccountId: v }));
      if (b.status !== 201) return b;
      const a = await api("x", "POST", `/bills/${b.body.id}/approve`, {});
      return a.status === 200 ? b : a;
    } });
  add({ name: "bill approval debit account override", endpoint: "POST /bills/{id}/approve", field: "debitAccountId", scope: "tenant",
    own: async () => fx.x.expense, foreign: async () => fx.y.expense,
    send: async (v) => api("x", "POST", `/bills/${ok(await api("x", "POST", "/bills", billBody(fx.x.vendor)), "bill").id}/approve`, { debitAccountId: v }) });
  add({ name: "recognition schedule expense account", endpoint: "POST /recognition-schedules", field: "expenseAccountId", scope: "tenant",
    own: async () => fx.x.expense, foreign: async () => fx.y.expense,
    send: (v) => api("x", "POST", "/recognition-schedules", { kind: "accrual", description: "Accrual", totalAmount: 300, periods: 3, startPeriod: TODAY.slice(0, 7), expenseAccountId: v, balanceAccountId: fx.x.accrued, reference: `RS${next()}` }) });
  let computation: { id: number; versionId: number } | null = null;
  add({ name: "tax computation adjustment account", endpoint: "POST /tax/computations/{id}/versions/{vid}/adjustments", field: "accountId", scope: "tenant",
    own: async () => fx.x.expense, foreign: async () => fx.y.expense,
    send: async (v) => {
      if (!computation) {
        const c = ok(await api("x", "POST", "/tax/computations", { kind: "zakat", fiscalYearLabel: 2025 }), "computation");
        computation = { id: c.id, versionId: c.version.id };
      }
      return api("x", "POST", `/tax/computations/${computation.id}/versions/${computation.versionId}/adjustments`, { target: "adjusted_net_profit", effect: "increase", amount: 10, reason: "test", legalReference: "Art. 1", accountId: v });
    } });
  add({ name: "bank transaction category (create)", endpoint: "POST /transactions", field: "categoryId", scope: "tenant",
    own: async () => fx.x.expense, foreign: async () => fx.y.expense,
    send: (v) => api("x", "POST", "/transactions", { date: TODAY, description: "Txn", amount: 10, currency: "SAR", type: "debit", categoryId: v, bankAccountId: fx.x.bank }) });
  add({ name: "bank transaction category (edit)", endpoint: "PATCH /transactions/{id}", field: "categoryId", scope: "tenant",
    own: async () => fx.x.expense, foreign: async () => fx.y.expense,
    send: async (v) => api("x", "PATCH", `/transactions/${await mkTxn("x", "debit", 10)}`, { categoryId: v, bankAccountId: fx.x.bank }) });

  // ── bank accounts (company-scoped) ─────────────────────────────────────────
  const bankCase = (name: string, endpoint: string, send: (v: Id) => Promise<Res>, own: () => Promise<Id> = async () => fx.x.bank) =>
    add({ name, endpoint, field: "bankAccountId", scope: "tenant+company", own, foreign: async () => fx.y.bank, otherCompany: async () => fx.x2.bank, send });
  bankCase("bank transaction (create)", "POST /transactions", (v) => api("x", "POST", "/transactions", { date: TODAY, description: "Txn", amount: 10, currency: "SAR", type: "debit", categoryId: fx.x.expense, bankAccountId: v }));
  bankCase("customer receipt", "POST /payments", (v) => api("x", "POST", "/payments", { customerId: fx.x.customer, amount: 10, bankAccountId: v, paidAt: TODAY }));
  bankCase("invoice payment", "POST /invoices/{id}/pay", async (v) => api("x", "POST", `/invoices/${await mkInvoice("x", fx.x.customer)}/pay`, { amount: 1150, bankAccountId: v, paidAt: TODAY }));
  bankCase("bill payment", "POST /bills/{id}/pay", async (v) => api("x", "POST", `/bills/${await mkBill("x", fx.x.vendor)}/pay`, { amount: 1000, bankAccountId: v, paidAt: TODAY }));
  bankCase("bank transfer (from)", "POST /bank-transfers", async (v) => api("x", "POST", "/bank-transfers", { fromBankAccountId: v, toBankAccountId: await mkBank("x"), amount: 1, transferDate: TODAY, idempotencyKey: `T${next()}` }));
  // Own bank FRESH: a completed reconciliation locks its bank through the date.
  bankCase("bank reconciliation", "POST /bank-reconciliations", (v) => api("x", "POST", "/bank-reconciliations", { bankAccountId: v, asOf: TODAY, statementBalance: 0 }), () => mkBank("x"));
  bankCase("supplier payment", "POST /supplier-payments", (v) => api("x", "POST", "/supplier-payments", { vendorId: fx.x.vendor, amount: 10, bankAccountId: v, paidAt: TODAY }));
  bankCase("payment plan", "POST /treasury/payment-plans", async (v) => api("x", "POST", "/treasury/payment-plans", { billId: await mkBill("x", fx.x.vendor), amount: 100, plannedDate: TODAY, bankAccountId: v }));
  bankCase("customer refund", "POST /payments/refunds", async (v) => {
    const p = ok(await api("x", "POST", "/payments", { customerId: fx.x.customer, amount: 50, bankAccountId: fx.x.bank, paidAt: TODAY }), "deposit");
    return api("x", "POST", "/payments/refunds", { customerId: fx.x.customer, origin: "deposit", paymentId: p.id, amount: 10, bankAccountId: v, reason: "returned" });
  });
  bankCase("expense paid from a bank (bill recorded as expense)", "POST /bills", async (v) => {
    const b = await api("x", "POST", "/bills", billBody(fx.x.vendor, { recordedAsExpense: true, expensePaidFromBankAccountId: v, expensePaidAt: TODAY }));
    if (b.status !== 201) return b;
    const a = await api("x", "POST", `/bills/${b.body.id}/approve`, {});
    return a.status === 200 ? b : a;
  });
  let batchId = 0;
  bankCase("migration chart row mapped to a bank", "PATCH /migration/batches/{id}/chart/{rowId}", async (v) => {
    if (!batchId) batchId = ok(await api("x", "POST", "/migration/batches", { sourceSystem: "Prev", cutoverDate: "2026-07-01" }), "batch").id;
    const chart = ok(await api("x", "PUT", `/migration/batches/${batchId}/chart`, { rows: [{ sourceCode: `1${next()}`, sourceName: "Bank", sourceType: "asset", openingDebit: 0, sourceRole: "bank" }] }), "chart");
    return api("x", "PATCH", `/migration/batches/${batchId}/chart/${chart.rows[0].id}`, { decision: "map_to_bank", targetBankAccountId: v });
  });

  // ── customers / vendors / products (organization-scoped) ───────────────────
  add({ name: "invoice customer", endpoint: "POST /invoices", field: "customerId", scope: "tenant", own: async () => fx.x.customer, foreign: async () => fx.y.customer,
    send: (v) => api("x", "POST", "/invoices", { invoiceNumber: `I${next()}`, date: TODAY, customerId: v, items: [{ description: "S", quantity: 1, unitPrice: 10, vatRate: 15 }] }) });
  const productStored = async (v: Id) => (await pool.query(`SELECT 1 FROM invoice_items WHERE organization_id = $1 AND product_id = $2`, [org.x, v])).rowCount! > 0;
  add({ name: "invoice line product", endpoint: "POST /invoices", field: "items[].productId", scope: "tenant", fixed: true, own: async () => fx.x.product, foreign: async () => fx.y.product,
    send: (v) => api("x", "POST", "/invoices", { invoiceNumber: `I${next()}`, date: TODAY, customerId: fx.x.customer, items: [{ description: "S", quantity: 1, unitPrice: 10, vatRate: 15, productId: v }] }),
    stored: productStored });
  // The same column through the draft EDIT (closed by the same key and the same service check).
  add({ name: "invoice line product (draft edit)", endpoint: "PATCH /invoices/{id}", field: "items[].productId", scope: "tenant", fixed: true, own: async () => fx.x.product, foreign: async () => fx.y.product,
    send: async (v) => api("x", "PATCH", `/invoices/${await draftInvoice()}`, { items: [{ description: "S", quantity: 1, unitPrice: 10, vatRate: 15, productId: v }] }),
    stored: productStored });
  add({ name: "quotation customer", endpoint: "POST /quotations", field: "customerId", scope: "tenant", own: async () => fx.x.customer, foreign: async () => fx.y.customer,
    send: (v) => api("x", "POST", "/quotations", { date: TODAY, customerId: v, items: [{ description: "S", quantity: 1, unitPrice: 10 }] }) });
  add({ name: "receipt customer", endpoint: "POST /payments", field: "customerId", scope: "tenant", own: async () => fx.x.customer, foreign: async () => fx.y.customer,
    send: (v) => api("x", "POST", "/payments", { customerId: v, amount: 10, bankAccountId: fx.x.bank, paidAt: TODAY }) });
  add({ name: "manual journal AR party", endpoint: "POST /journal-entries", field: "lines[].customerId", scope: "tenant", own: async () => fx.x.customer, foreign: async () => fx.y.customer,
    send: async (v) => api("x", "POST", "/journal-entries", { entryNumber: `J${next()}`, date: TODAY, description: "AR", lines: [
      { accountId: await sys("x", "AR"), accountName: "AR", debitAmount: 10, creditAmount: 0, customerId: v },
      { accountId: fx.x.income, accountName: "Inc", debitAmount: 0, creditAmount: 10 }] }) });
  add({ name: "bill vendor", endpoint: "POST /bills", field: "vendorId", scope: "tenant", own: async () => fx.x.vendor, foreign: async () => fx.y.vendor,
    send: (v) => api("x", "POST", "/bills", billBody(v as number)) });
  add({ name: "purchase order vendor", endpoint: "POST /purchase-orders", field: "vendorId", scope: "tenant", own: async () => fx.x.vendor, foreign: async () => fx.y.vendor,
    send: (v) => api("x", "POST", "/purchase-orders", { date: TODAY, vendorId: v, items: [{ description: "S", quantity: 1, unitPrice: 10 }] }) });
  add({ name: "supplier payment vendor", endpoint: "POST /supplier-payments", field: "vendorId", scope: "tenant", own: async () => fx.x.vendor, foreign: async () => fx.y.vendor,
    send: (v) => api("x", "POST", "/supplier-payments", { vendorId: v, amount: 10, bankAccountId: fx.x.bank, paidAt: TODAY }) });
  add({ name: "WHT treaty relief vendor", endpoint: "POST /tax/wht/reliefs", field: "vendorId", scope: "tenant",
    own: async () => ok(await api("x", "POST", "/vendors", { name: `NR${next()}`, country: "IE", residency: "non_resident", whtDefaultPaymentType: "royalty", foreignTaxId: `IE${next()}` }), "nr vendor").id,
    foreign: async () => ok(await api("y", "POST", "/vendors", { name: `NR${next()}`, country: "IE", residency: "non_resident", whtDefaultPaymentType: "royalty", foreignTaxId: `IE${next()}` }), "nr vendor y").id,
    send: (v) => api("x", "POST", "/tax/wht/reliefs", { vendorId: v, paymentType: "royalty", reducedRate: 0.05, treatyCountry: "IE", zatcaApprovalReference: `Z${next()}`, residencyCertificateReference: `R${next()}`, validFrom: TODAY, validTo: "2027-12-31" }) });
  add({ name: "manual journal AP party", endpoint: "POST /journal-entries", field: "lines[].vendorId", scope: "tenant", own: async () => fx.x.vendor, foreign: async () => fx.y.vendor,
    send: async (v) => api("x", "POST", "/journal-entries", { entryNumber: `J${next()}`, date: TODAY, description: "AP", lines: [
      { accountId: fx.x.expense, accountName: "Exp", debitAmount: 10, creditAmount: 0 },
      { accountId: await sys("x", "AP"), accountName: "AP", debitAmount: 0, creditAmount: 10, vendorId: v }] }) });

  // ── assets ─────────────────────────────────────────────────────────────────
  add({ name: "asset's category", endpoint: "POST /assets", field: "categoryId", scope: "tenant+company",
    own: async () => fx.x.assetCategory, foreign: async () => fx.y.assetCategory, otherCompany: async () => fx.x2.assetCategory,
    send: (v) => api("x", "POST", "/assets", { name: `A${next()}`, categoryId: v, acquisitionDate: TODAY, cost: 100 }) });
  const custodianStored = async (v: Id) => (await pool.query(`SELECT 1 FROM fixed_assets WHERE organization_id = $1 AND custodian_user_id = $2`, [org.x, v])).rowCount! > 0;
  add({ name: "asset custodian (a USER — must hold a membership in the asset's organization)", endpoint: "POST /assets", field: "custodianUserId", scope: "tenant", fixed: true,
    own: async () => uid.x, foreign: async () => uid.y,
    send: (v) => api("x", "POST", "/assets", { name: `A${next()}`, categoryId: fx.x.assetCategory, acquisitionDate: TODAY, cost: 100, custodianUserId: v }),
    stored: custodianStored });
  add({ name: "asset custodian (edit)", endpoint: "PUT /assets/{id}", field: "custodianUserId", scope: "tenant", fixed: true,
    own: async () => uid.x, foreign: async () => uid.y,
    send: async (v) => api("x", "PUT", `/assets/${await mkAsset("x", fx.x.assetCategory)}`, { custodianUserId: v }),
    stored: custodianStored });
  add({ name: "bill capitalises an asset (company-scoped)", endpoint: "POST /bills", field: "capitalisesAssetId", scope: "tenant+company", fixed: true,
    own: async () => mkAsset("x", fx.x.assetCategory), foreign: async () => mkAsset("y", fx.y.assetCategory), otherCompany: async () => fx.x2.asset,
    send: (v) => api("x", "POST", "/bills", billBody(fx.x.vendor, { capitalisesAssetId: v, items: [{ description: "Asset", quantity: 1, unitPrice: 1000, vatRate: 0 }] })),
    stored: async (v) => (await pool.query(`SELECT 1 FROM bills WHERE organization_id = $1 AND capitalises_asset_id = $2`, [org.x, v])).rowCount! > 0 });
  add({ name: "VAT capital-asset use record", endpoint: "POST /assets/vat-adjustments/use-records", field: "assetId", scope: "tenant+company",
    own: async () => fx.x.asset, foreign: async () => fx.y.asset, otherCompany: async () => fx.x2.asset,
    send: (v) => api("x", "POST", "/assets/vat-adjustments/use-records", { assetId: v, periodIndex: 1, actualUsePct: 100, basis: "exclusive_use" }) });

  // ── documents ──────────────────────────────────────────────────────────────
  add({ name: "bill evidence document (capture)", endpoint: "POST /bills", field: "captureId", scope: "tenant", missing: randomUUID(),
    own: () => plantCapture("x"), foreign: () => plantCapture("y"),
    send: (v) => api("x", "POST", "/bills", billBody(fx.x.vendor, { captureId: v })),
    stored: async (v) => (await pool.query(`SELECT 1 FROM captured_documents WHERE id = $1 AND organization_id <> $2 AND bill_id IS NOT NULL`, [v, org.x])).rowCount! > 0 });
  add({ name: "bulk categorize bank transactions", endpoint: "POST /categorize", field: "transactionIds[]", scope: "tenant", judgeByEffectOnly: true,
    own: () => mkTxn("x", "debit", 10, { description: "OFFICE RENT" }), foreign: () => mkTxn("y", "debit", 10, { description: "OFFICE RENT" }),
    send: (v) => api("x", "POST", "/categorize", { transactionIds: [v], overrideExisting: true }),
    stored: async (v) => (await pool.query(`SELECT 1 FROM transactions WHERE id = $1 AND organization_id <> $2 AND category_id IS NOT NULL`, [v, org.x])).rowCount! > 0 });

  // ── allocation targets and originals ───────────────────────────────────────
  add({ name: "receipt allocated to an invoice", endpoint: "POST /payments", field: "allocations[].invoiceId", scope: "tenant+company",
    own: () => mkInvoice("x", fx.x.customer), foreign: async () => fx.y.invoice, otherCompany: async () => fx.x2.invoice,
    send: (v) => api("x", "POST", "/payments", { customerId: fx.x.customer, amount: 10, bankAccountId: fx.x.bank, paidAt: TODAY, allocations: [{ invoiceId: v, amount: 10 }] }) });
  add({ name: "deposit allocated later to an invoice", endpoint: "POST /payments/{id}/allocate", field: "allocations[].invoiceId", scope: "tenant+company",
    own: () => mkInvoice("x", fx.x.customer), foreign: async () => fx.y.invoice, otherCompany: async () => fx.x2.invoice,
    send: async (v) => {
      const p = ok(await api("x", "POST", "/payments", { customerId: fx.x.customer, amount: 10, bankAccountId: fx.x.bank, paidAt: TODAY }), "deposit");
      return api("x", "POST", `/payments/${p.id}/allocate`, { allocations: [{ invoiceId: v, amount: 10 }] });
    } });
  add({ name: "credit note applied to an invoice", endpoint: "POST /payments/credit-notes/{id}/apply", field: "allocations[].invoiceId", scope: "tenant+company",
    own: () => mkInvoice("x", fx.x.customer), foreign: async () => fx.y.invoice, otherCompany: async () => fx.x2.invoice,
    send: async (v) => {
      // The original is PAID first, so the credit note stays unapplied (customer credit) and can be applied elsewhere.
      const orig = await mkInvoice("x", fx.x.customer);
      ok(await api("x", "POST", `/invoices/${orig}/pay`, { amount: 1150, bankAccountId: fx.x.bank, paidAt: TODAY }), "pay original");
      const cn = ok(await api("x", "POST", "/invoices", { invoiceNumber: `CN${next()}`, date: TODAY, customerId: fx.x.customer, documentType: "credit_note", originalInvoiceId: orig, noteReason: "Price correction", items: [{ description: "A", quantity: 1, unitPrice: 10, vatRate: 15 }] }), "cn");
      ok(await api("x", "POST", `/invoices/${cn.id}/approve`, {}), "cn approve");
      return api("x", "POST", `/payments/credit-notes/${cn.id}/apply`, { allocations: [{ invoiceId: v, amount: 1 }] });
    } });
  add({ name: "supplier payment allocated to a bill", endpoint: "POST /supplier-payments", field: "allocations[].billId", scope: "tenant",
    own: () => mkBill("x", fx.x.vendor), foreign: async () => fx.y.bill,
    send: (v) => api("x", "POST", "/supplier-payments", { vendorId: fx.x.vendor, amount: 10, bankAccountId: fx.x.bank, paidAt: TODAY, allocations: [{ billId: v, amount: 10 }] }) });
  add({ name: "supplier advance allocated later to a bill", endpoint: "POST /supplier-payments/{id}/allocate", field: "allocations[].billId", scope: "tenant",
    own: () => mkBill("x", fx.x.vendor), foreign: async () => fx.y.bill,
    send: async (v) => {
      const sp = ok(await api("x", "POST", "/supplier-payments", { vendorId: fx.x.vendor, amount: 10, bankAccountId: fx.x.bank, paidAt: TODAY, classification: "advance" }), "advance");
      return api("x", "POST", `/supplier-payments/${sp.id}/allocate`, { allocations: [{ billId: v, amount: 10 }] });
    } });
  add({ name: "bank statement line settles an invoice", endpoint: "POST /transactions/{id}/settle", field: "invoiceId", scope: "tenant+company",
    own: () => mkInvoice("x", fx.x.customer), foreign: async () => fx.y.invoice, otherCompany: async () => fx.x2.invoice,
    send: async (v) => api("x", "POST", `/transactions/${await plantPendingLine("credit", 1150)}/settle`, { invoiceId: v }) });
  add({ name: "bank statement line settles a bill (the investigation's one unproven row)", endpoint: "POST /transactions/{id}/settle", field: "billId", scope: "tenant",
    own: () => mkBill("x", fx.x.vendor), foreign: async () => fx.y.bill,
    send: async (v) => api("x", "POST", `/transactions/${await plantPendingLine("debit", 1000)}/settle`, { billId: v }),
    stored: async (v) => (await pool.query(`SELECT 1 FROM transactions WHERE organization_id = $1 AND settles_bill_id = $2`, [org.x, v])).rowCount! > 0 });
  add({ name: "payment plan for a bill", endpoint: "POST /treasury/payment-plans", field: "billId", scope: "tenant",
    own: () => mkBill("x", fx.x.vendor), foreign: async () => fx.y.bill,
    send: (v) => api("x", "POST", "/treasury/payment-plans", { billId: v, amount: 10, plannedDate: TODAY }) });
  add({ name: "credit/debit note's original invoice", endpoint: "POST /invoices", field: "originalInvoiceId", scope: "tenant+company",
    own: () => mkInvoice("x", fx.x.customer), foreign: async () => fx.y.invoice, otherCompany: async () => fx.x2.invoice,
    send: (v) => api("x", "POST", "/invoices", { invoiceNumber: `CN${next()}`, date: TODAY, customerId: fx.x.customer, documentType: "credit_note", originalInvoiceId: v, noteReason: "Price correction", items: [{ description: "A", quantity: 1, unitPrice: 10, vatRate: 15 }] }) });
  add({ name: "supplier credit note's original bill", endpoint: "POST /bills", field: "creditNoteAgainstBillId", scope: "tenant",
    own: () => mkBill("x", fx.x.vendor), foreign: async () => fx.y.bill,
    send: (v) => api("x", "POST", "/bills", billBody(fx.x.vendor, { documentType: "credit_note", creditNoteAgainstBillId: v, items: [{ description: "Return", quantity: 1, unitPrice: 10, vatRate: 0 }] })) });
  add({ name: "refund of a receipt", endpoint: "POST /payments/refunds", field: "paymentId", scope: "tenant",
    own: async () => ok(await api("x", "POST", "/payments", { customerId: fx.x.customer, amount: 50, bankAccountId: fx.x.bank, paidAt: TODAY }), "deposit").id,
    foreign: async () => fx.y.payment,
    send: (v) => api("x", "POST", "/payments/refunds", { customerId: fx.x.customer, origin: "deposit", paymentId: v, amount: 10, bankAccountId: fx.x.bank, reason: "returned" }) });

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    org.x = await h.mkOrg("x");
    org.y = await h.mkOrg("y");
    co.x1 = await h.mkCompany(org.x, "G04S x1", "305050505050503");
    co.x2 = await h.mkCompany(org.x, "G04S x2", "305050505050513");
    co.y1 = await h.mkCompany(org.y, "G04S y1", "305050505050523");
    uid.x = await h.mkUser("x", PW, org.x);
    uid.y = await h.mkUser("y", PW, org.y);
    uid.x2member = await h.mkUser("x2member", PW, org.x, "bookkeeper");
    await h.start();
    for (const k of ["x", "y"] as const) expect(await h.login(k, h.email(k), PW)).toBe(200);

    // The detector: every single-column foreign key between two tenant-scoped tables.
    const fks = (await pool.query(`
      SELECT c.conrelid::regclass::text AS src, a.attname AS col, c.confrelid::regclass::text AS dst, af.attname AS dcol,
             EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_name = c.conrelid::regclass::text AND x.column_name = 'company_id') AS src_co,
             EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_name = c.confrelid::regclass::text AND x.column_name = 'company_id') AS dst_co
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
       WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND a.attname NOT IN ('organization_id', 'company_id')
         AND EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_name = c.conrelid::regclass::text AND x.column_name = 'organization_id')
         AND EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_name = c.confrelid::regclass::text AND x.column_name = 'organization_id')`)).rows;
    expect(fks.length, "the detector reads the catalog's tenant keys (not vacuous)").toBeGreaterThan(100);
    edgeSql = fks.map((f) =>
      `SELECT '${f.src}.${f.col}' AS e, count(*) FILTER (WHERE d.organization_id <> s.organization_id)::int AS org_n, ` +
      (f.src_co && f.dst_co ? `count(*) FILTER (WHERE d.organization_id = s.organization_id AND d.company_id IS NOT NULL AND s.company_id IS NOT NULL AND d.company_id <> s.company_id)::int` : `0`) +
      ` AS co_n FROM ${f.src} s JOIN ${f.dst} d ON d."${f.dcol}" = s."${f.col}" WHERE s.organization_id = $1`,
    ).join(" UNION ALL ");

    // Shared fixtures: X's own (company x1), Y's (another tenant), X2's (same org, other company).
    for (const w of ["x", "y"] as const) {
      fx[w] = {
        bank: await mkBank(w), customer: await mkCustomer(w), vendor: await mkVendor(w),
        expense: await sys(w, "RENT_UTILITIES"), income: await sys(w, "OTHER_INCOME"),
        fixedAssets: await sys(w, "FIXED_ASSETS"), accum: await sys(w, "ACCUMULATED_DEPRECIATION"), deprExp: await sys(w, "DEPRECIATION_EXPENSE"),
        accrued: await sys(w, "ACCRUED_LIABILITIES"),
        product: (await pool.query(`INSERT INTO products (organization_id, name) VALUES ($1,$2) RETURNING id`, [org[w], `Product ${w}`])).rows[0].id,
      };
      fx[w].assetCategory = await mkAssetCategory(w);
      fx[w].asset = await mkAsset(w, fx[w].assetCategory);
    }
    fx.x2 = {
      bank: (await inX2(() => bankAccountsService.create({ name: "X2 Bank", bankName: "Bank", currency: "SAR" }))).id,
      assetCategory: (await inX2(() => assetsService.createCategory({ name: "X2 Cat", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, uid.x))).id,
    };
    fx.x2.asset = (await inX2(() => assetsService.create({ name: "X2 Asset", categoryId: fx.x2.assetCategory, acquisitionDate: TODAY, cost: 1000 }, uid.x)) as any).id;
    fx.x2.invoice = await inX2(async () => {
      const inv: any = await invoicesService.create({ invoiceNumber: `X2-${next()}`, date: TODAY, customerId: fx.x.customer, items: [{ description: "S", quantity: 1, unitPrice: 1000, vatRate: 15 }] }, uid.x);
      await invoicesService.approve(inv.id, uid.x);
      return inv.id as number;
    });
    fx.y.invoice = await mkInvoice("y", fx.y.customer);
    fx.y.bill = await mkBill("y", fx.y.vendor);
    fx.y.payment = ok(await api("y", "POST", "/payments", { customerId: fx.y.customer, amount: 100, bankAccountId: fx.y.bank, paidAt: TODAY }), "y payment").id;
  }, 300_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("the detector sees a planted cross-tenant edge (anti-vacuity)", async () => {
    const before = await crossEdges();
    const draft = ok(await api("x", "POST", "/invoices", { invoiceNumber: `PLANT${next()}`, date: TODAY, customerId: fx.x.customer, items: [{ description: "S", quantity: 1, unitPrice: 1, vatRate: 15 }] }), "draft");
    await pool.query(`UPDATE invoices SET customer_id = $1 WHERE id = $2`, [fx.y.customer, draft.id]);
    try {
      expect(Object.keys(delta(before, await crossEdges()))).toContain("invoices.customer_id → other tenant");
    } finally {
      await pool.query(`UPDATE invoices SET customer_id = $1 WHERE id = $2`, [fx.x.customer, draft.id]);
    }
    expect(delta(before, await crossEdges())).toEqual({});
  });

  // ── SHARING: organization-level entities serve every company of the organization ─────
  it("CONTROL (sharing): the organization's PRODUCT on a line of its OTHER company's invoice is accepted", async () => {
    const inv: any = await inX2(() => invoicesService.create({ invoiceNumber: `X2P-${next()}`, date: TODAY, customerId: fx.x.customer, items: [{ description: "S", quantity: 1, unitPrice: 10, vatRate: 15, productId: fx.x.product }] }, uid.x));
    const { rows } = await pool.query(`SELECT company_id, product_id FROM invoice_items WHERE invoice_id = $1`, [inv.id]);
    expect(rows).toEqual([{ company_id: co.x2, product_id: fx.x.product }]);
  });

  it("CONTROL (sharing): a member of the organization is a valid custodian of its OTHER company's asset", async () => {
    const a: any = await inX2(() => assetsService.create({ name: "X2 custodied", categoryId: fx.x2.assetCategory, acquisitionDate: TODAY, cost: 100, custodianUserId: uid.x2member }, uid.x));
    expect(a.custodianUserId).toBe(uid.x2member);
  });

  for (const c of CASES) {
    it(`🔴 ${c.endpoint} · ${c.field} — ${c.name}`, async () => {
      const control = await c.send(await c.own());
      expect(control.status, `CONTROL with the tenant's own id must succeed: ${JSON.stringify(control.body).slice(0, 300)}`).toBeGreaterThanOrEqual(200);
      expect(control.status).toBeLessThan(300);
      const attempt = async (label: string, value: Id) => {
        const before = await crossEdges();
        const r = await c.send(value);
        const edges = delta(before, await crossEdges());
        const stored = c.stored ? await c.stored(value) : false;
        return { label, status: r.status, body: r.body, newCrossEdges: edges, stored };
      };
      const results = [await attempt("other tenant", await c.foreign())];
      if (c.otherCompany) results.push(await attempt("same org, other company", await c.otherCompany()));
      for (const a of results) {
        const accepted = (!c.judgeByEffectOnly && a.status >= 200 && a.status < 300) || Object.keys(a.newCrossEdges).length > 0 || a.stored;
        expect(accepted, `${a.label}: ${a.status} ${JSON.stringify(a.body).slice(0, 200)} edges=${JSON.stringify(a.newCrossEdges)} stored=${a.stored}`).toBe(false);
        if (!c.judgeByEffectOnly) expect(a.status, `${a.label}: a controlled 4xx`).toBeLessThan(500);
      }
      if (c.judgeByEffectOnly) return;
      const missing = await c.send(c.missing ?? MISSING);
      expect(missing.status, `missing id: a controlled 4xx, never ${missing.status}`).toBeGreaterThanOrEqual(400);
      expect(missing.status).toBeLessThan(500);
      expect(missing.status, "missing ≡ foreign (status)").toBe(results[0]!.status);
      if (c.fixed) expect(missing.body, "missing ≡ foreign (the whole body)").toEqual(results[0]!.body);
    }, 120_000);
  }
});
