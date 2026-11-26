/**
 * 🔴 19B 19.12 (control 19B-S7A) — GROUPING AND SUBTOTALS in the report builder.
 *
 * Owner, 2026-11-26: "Withholding applies before any total: a subtotal or grand total of a field the role can't read is
 * withheld, never computed. Test empty groups, rounding, and a one-row group."
 *
 *  - the pure grouping (no database): a total of a column the role may not read is LISTED as withheld and its cells are
 *    never read (the fixture's cell throws when touched); sums are exact to the halala; a one-row group's subtotal is its
 *    row; a missing key is its own group; no rows gives no groups.
 *  - over HTTP, on rows the product's own paths wrote: the groups' subtotals add up to the grand total, and the grand
 *    total equals the same figure the fixed reports compute (the VAT return, the trial balance) — two ways, non-zero.
 *  - 🔴 journal lines have NO grand total: debits equal credits across whole entries, so the number would mean nothing.
 *  - a grouping the dataset does not offer is refused by name; a saved report keeps its grouping; the CSV carries the
 *    subtotal rows.
 * DB-backed parts skip on the placeholder.
 */
process.env.PORT ??= "3247";
process.env.SESSION_SECRET ??= "s7-report-grouping-0000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { DATASETS, SALES_DOCUMENTS, columnClass } from "../lib/reports/datasets";
import { columnLevel, type DecidedColumn } from "../lib/reports/decide";
import { groupRows } from "../lib/reports/grouping";
import { __setDatasetRowLimitsForTests } from "../services/reporting/reportExport.service";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s7-report-grouping-password-2026";
const h = g04Harness("s7grp");
const WINDOW = "date_from=2026-10-01&date_to=2026-10-31";
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
const r2 = (n: number) => Math.round(n * 100) / 100;
const all = () => true;
const shown = (keys: string[], level: (k: string) => DecidedColumn["level"] = () => "read"): DecidedColumn[] =>
  keys.map((k) => ({ ...columnLevel(all, SALES_DOCUMENTS, SALES_DOCUMENTS.columns.find((c) => c.key === k)!), level: level(k) }));
const totalOf = (g: { totals: { column: string; total: number }[] }, column: string) => g.totals.find((t) => t.column === column)?.total;

describe("19B 19.12 — the grouping itself (pure)", () => {
  it("🔴 a total of a column the role may not read is withheld and NEVER computed: its cells are not read at all", () => {
    const touched: string[] = [];
    const row = (customerName: string, signedSubtotal: number) => {
      const r: Record<string, unknown> = { customerName, signedSubtotal, currency: "SAR" };
      Object.defineProperty(r, "signedVat", { enumerable: true, get() { touched.push(customerName); throw new Error("a withheld cell was read"); } });
      return r;
    };
    const g = groupRows(SALES_DOCUMENTS, "customerName", shown(["customerName", "signedSubtotal", "signedVat"], (k) => (k === "signedVat" ? "none" : "read")), [row("A", 100), row("A", 50), row("B", 7)]);
    expect(touched).toEqual([]);
    expect(g.withheldTotals.map((c) => c.column.key)).toEqual(["signedVat"]);
    for (const grp of [...g.groups, g.grandTotal!]) expect(grp.totals.map((t) => t.column)).toEqual(["signedSubtotal"]);
    expect(g.groups.map((x) => [x.key, x.count, totalOf(x, "signedSubtotal")])).toEqual([["A", 2, 150], ["B", 1, 7]]);
    expect(totalOf(g.grandTotal!, "signedSubtotal")).toBe(157);
  });

  it("a conditional column (read on some rows only) is never totalled either", () => {
    const cols = shown(["customerName", "signedSubtotal"]).map((c) => (c.column.key === "signedSubtotal" ? { ...c, rowCondition: { by: "status", in: ["x"] } } : c));
    const g = groupRows(SALES_DOCUMENTS, "customerName", cols, [{ customerName: "A", signedSubtotal: 1, status: "y" }]);
    expect(g.withheldTotals.map((c) => c.column.key)).toEqual(["signedSubtotal"]);
    expect(g.groups[0]!.totals).toEqual([]);
  });

  it("🔴 rounding: sums are exact to the halala (0.10 + 0.20 is 0.30; thirds add back), strings and numbers alike", () => {
    const rows = [0.1, 0.2, "33.33", "33.33", 33.34, -0.01, "1234567.89"].map((v) => ({ customerName: "A", signedSubtotal: v, currency: "SAR" }));
    const g = groupRows(SALES_DOCUMENTS, "customerName", shown(["customerName", "signedSubtotal"]), rows);
    expect(totalOf(g.groups[0]!, "signedSubtotal")).toBe(1234668.18);
    expect(totalOf(g.grandTotal!, "signedSubtotal")).toBe(1234668.18);
    const three = groupRows(SALES_DOCUMENTS, "customerName", shown(["customerName", "signedSubtotal"]), [{ customerName: "A", signedSubtotal: 0.1 }, { customerName: "A", signedSubtotal: 0.2 }]);
    expect(totalOf(three.groups[0]!, "signedSubtotal")).toBe(0.3);
  });

  it("🔴 a one-row group's subtotal is that row; a missing key is its own group, last; no rows gives no groups and a zero grand total", () => {
    const g = groupRows(SALES_DOCUMENTS, "customerName", shown(["customerName", "signedTotal"]), [
      { customerName: "Solo", signedTotal: 41.5 }, { customerName: null, signedTotal: 2 }, { customerName: "Pair", signedTotal: 1 }, { customerName: "Pair", signedTotal: -3 }, { signedTotal: 5 },
    ]);
    expect(g.groups.map((x) => [x.key, x.count, totalOf(x, "signedTotal")])).toEqual([["Pair", 2, -2], ["Solo", 1, 41.5], [null, 2, 7]]);
    expect([g.grandTotal!.count, totalOf(g.grandTotal!, "signedTotal")]).toEqual([5, 46.5]);
    const none = groupRows(SALES_DOCUMENTS, "customerName", shown(["customerName", "signedTotal"]), []);
    expect(none.groups).toEqual([]);
    expect([none.grandTotal!.count, totalOf(none.grandTotal!, "signedTotal")]).toEqual([0, 0]);
  });

  it("a date groups by its month; a group mixing currencies has no money total (the number would mean nothing)", () => {
    const g = groupRows(SALES_DOCUMENTS, "date", shown(["date", "signedTotal"]), [
      { date: "2026-10-05", signedTotal: 1, currency: "SAR" }, { date: "2026-10-31", signedTotal: 2, currency: "SAR" }, { date: "2026-11-01", signedTotal: 4, currency: "USD" },
    ]);
    expect(g.groups.map((x) => [x.key, x.count, totalOf(x, "signedTotal"), x.mixedCurrency])).toEqual([["2026-10", 2, 3, false], ["2026-11", 1, 4, false]]);
    expect([g.grandTotal!.mixedCurrency, g.grandTotal!.totals]).toEqual([true, []]);
  });

  it("🔴 what a dataset offers: every grouping column and every totalled column is `standard` (a total's class is its column's), and journal lines have no grand total", () => {
    for (const ds of Object.values(DATASETS)) {
      const groupable = ds.columns.filter((c) => c.groupable).map((c) => c.key);
      expect([ds.name, groupable.length > 0]).toEqual([ds.name, true]);
      for (const k of [...groupable, ...ds.totals]) expect([ds.name, k, columnClass(ds, k).cls]).toEqual([ds.name, k, "standard"]);
      for (const k of ds.totals) expect([ds.name, k, ds.columns.find((c) => c.key === k)?.kind]).toEqual([ds.name, k, "money"]);
    }
    expect(DATASETS.journal_lines!.grandTotal).toBe(false);
    // unsigned amounts are stored positive whatever the document's direction: adding them means nothing
    for (const k of ["subtotal", "vatAmount", "total"]) expect(DATASETS.sales_documents!.totals).not.toContain(k);
  });
});

describeDb("19B 19.12 — grouped reports over HTTP", () => {
  let orgId = "";
  const customers: Record<string, number> = {};
  const ok = (r: { status: number; text: string; body: any }, status = 200) => { expect(r.status, r.text).toBe(status); return r.body; };
  const run = async (who: string, dataset: string, qs: string) => h.api(who, "GET", `/reports/datasets/${dataset}/rows?${WINDOW}&limit=500&${qs}`);
  const sumTotals = (groups: any[], column: string) => r2(groups.reduce((s, g) => s + (totalOf(g, column) ?? 0), 0));
  async function invoice(customer: string, unitPrice: number, extra: Record<string, unknown> = {}) {
    const d = ok(await h.api("admin", "POST", "/invoices", { date: "2026-10-05", dueDate: "2026-10-31", customerId: customers[customer], items: [{ description: `S7 ${customer}`, quantity: 1, unitPrice, vatRate: 15 }], ...extra }), 201);
    ok(await h.api("admin", "POST", `/invoices/${d.id}/submit`));
    ok(await h.api("admin", "POST", `/invoices/${d.id}/approve`));
    return d.id as number;
  }

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S7 Grouping Co", "319898989898983");
    for (const role of ROLES) await h.mkUser(role, PW, orgId, role);
    for (const role of ROLES) expect(await h.login(role, h.email(role), PW)).toBe(200);
    for (const name of ["Alpha", "Beta"]) customers[name] = ok(await h.api("admin", "POST", "/customers", { name: `S7 ${name}` }), 201).id;
    const a = await invoice("Alpha", 1000);
    await invoice("Alpha", 33.33);
    await invoice("Alpha", 0.1);
    await invoice("Alpha", 200, { documentType: "credit_note", originalInvoiceId: a, noteReason: "Price correction" });
    await invoice("Beta", 400.2); // a one-row group
  }, 180_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  it("🔴 sales by customer: the subtotals add up to the grand total, which is the VAT return's total sales and its VAT — and a one-row group is its row", async () => {
    const d = ok(await run("viewer", "sales_documents", "group=customerName"));
    const ret = ok(await h.api("admin", "GET", "/reports/vat-return?period_from=2026-10&period_to=2026-10"));
    expect(d.groupedBy).toBe("customerName");
    expect(d.groups.map((g: any) => [g.key, g.count])).toEqual([["S7 Alpha", d.rows.filter((r: any) => r.customerName === "S7 Alpha").length], ["S7 Beta", 1]]);
    const beta = d.groups[1];
    const betaRow = d.rows.find((r: any) => r.customerName === "S7 Beta");
    expect([totalOf(beta, "signedSubtotal"), totalOf(beta, "signedVat"), totalOf(beta, "signedTotal")]).toEqual([betaRow.signedSubtotal, betaRow.signedVat, betaRow.signedTotal]);
    expect(totalOf(beta, "signedSubtotal")).toBe(400.2);
    for (const col of ["signedSubtotal", "signedVat", "signedTotal"]) {
      expect([col, sumTotals(d.groups, col)]).toEqual([col, totalOf(d.grandTotal, col)]);
      expect([col, totalOf(d.grandTotal, col)]).toEqual([col, r2(d.rows.reduce((s: number, r: any) => s + r[col], 0))]);
    }
    expect(totalOf(d.grandTotal, "signedSubtotal")).toBeGreaterThan(0);
    expect([totalOf(d.grandTotal, "signedSubtotal"), totalOf(d.grandTotal, "signedVat")]).toEqual([ret.salesSection.box5_totalSales, ret.salesSection.box6_vatOnStandardRatedSales]);
    expect(d.grandTotal.count).toBe(d.total);
    // the unsigned amounts are not totalled
    expect(d.grandTotal.totals.map((t: any) => t.column).sort()).toEqual(["signedSubtotal", "signedTotal", "signedVat"]);
  });

  it("🔴 the groups cover every row of the window, not the page: one row a page, the same subtotals", async () => {
    const full = ok(await run("admin", "sales_documents", "group=customerName"));
    const paged = ok(await h.api("admin", "GET", `/reports/datasets/sales_documents/rows?${WINDOW}&group=customerName&limit=1&offset=0`));
    expect(paged.rows.length).toBe(1);
    expect(paged.groups).toEqual(full.groups);
    expect(paged.grandTotal).toEqual(full.grandTotal);
    // the rows come group by group, whatever the sort — which orders the rows INSIDE a group
    const byNumber = ok(await run("admin", "sales_documents", "group=customerName&sort=-documentNumber"));
    const plain = ok(await run("admin", "sales_documents", "sort=-documentNumber"));
    expect(plain.rows[0].customerName).toBe("S7 Beta"); // ungrouped, the last number comes first
    expect(byNumber.rows.map((r: any) => r.customerName)).toEqual(["S7 Alpha", "S7 Alpha", "S7 Alpha", "S7 Alpha", "S7 Beta"]);
    const alpha = byNumber.rows.filter((r: any) => r.customerName === "S7 Alpha").map((r: any) => r.documentNumber);
    expect(alpha).toEqual([...alpha].sort().reverse());
  });

  it("🔴 a total is never worked out on part of the rows: above the row limit a grouped run and an export are refused WITH the count; a plain page still answers", async () => {
    __setDatasetRowLimitsForTests({ csv: 2 });
    try {
      const grouped = await run("admin", "sales_documents", "group=customerName");
      expect([grouped.status, grouped.body.code]).toEqual([422, "report_too_large"]);
      expect(grouped.body.error).toContain("this one has 5, and the limit is 2");
      const csv = await h.api("admin", "GET", `/reports/datasets/sales_documents/export?${WINDOW}`);
      expect([csv.status, csv.body.code]).toEqual([422, "export_too_large"]);
      expect(csv.body.error).toContain("would hold 5 rows; the limit is 2");
      expect(ok(await run("admin", "sales_documents", "columns=documentNumber")).total).toBe(5);
    } finally {
      __setDatasetRowLimitsForTests(null);
    }
    expect((await run("admin", "sales_documents", "group=customerName")).status).toBe(200);
  });

  it("only the shown columns are totalled; a grouping by month names the month", async () => {
    const d = ok(await run("admin", "sales_documents", "group=date&columns=date,documentNumber,signedTotal"));
    expect(d.groups.map((g: any) => g.key)).toEqual(["2026-10"]);
    expect(d.groups[0].totals.map((t: any) => t.column)).toEqual(["signedTotal"]);
  });

  it("🔴 journal lines by account: each account's debits and credits equal the trial balance's — and there is NO grand total", async () => {
    const d = ok(await run("viewer", "journal_lines", "group=accountId"));
    expect(d.grandTotal).toBeNull();
    expect(d.groups.length).toBeGreaterThan(2);
    const tb = ok(await h.api("admin", "GET", `/reports/trial-balance?${WINDOW}`));
    const byId = new Map((tb.accounts as any[]).filter((r) => r.accountId != null).map((r) => [String(r.accountId), r]));
    let compared = 0;
    for (const g of d.groups) {
      const t = byId.get(String(g.key));
      expect([g.key, !!t]).toEqual([g.key, true]);
      expect([g.key, totalOf(g, "debit"), totalOf(g, "credit")]).toEqual([g.key, t.debit, t.credit]);
      expect(typeof g.label).toBe("string"); // the account's name beside its id
      if (t.debit !== 0 || t.credit !== 0) compared += 1;
    }
    expect(compared).toBeGreaterThan(2);
  });

  it("🔴 a missing key is its own group; an empty window has no groups; a grouping the data does not offer is refused by name", async () => {
    const bankId = ok(await h.api("admin", "POST", "/bank-accounts", { name: "S7 Ops", bankName: "SNB", currency: "SAR" }), 201).id;
    await pool.query(
      `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, kind, review_status, bank_account_id)
       SELECT $1, c.id, '2026-10-12', 'S7 ATM WITHDRAWAL', '1000.00', 'debit', 'transfer', 'accepted', $2 FROM companies c WHERE c.organization_id = $1`,
      [orgId, bankId],
    );
    const cash = ok(await run("bookkeeper", "cash_movements", "group=categoryName"));
    expect(cash.groups.map((g: any) => [g.key, g.count, totalOf(g, "signedAmount")])).toEqual([[null, 1, -1000]]);
    const empty = ok(await h.api("admin", "GET", "/reports/datasets/sales_documents/rows?date_from=2020-01-01&date_to=2020-01-31&group=customerName"));
    expect([empty.groups, empty.grandTotal.count, totalOf(empty.grandTotal, "signedTotal")]).toEqual([[], 0, 0]);
    const refused = await run("admin", "sales_documents", "group=documentNumber");
    expect([refused.status, refused.body.code]).toEqual([400, "report_group_not_supported"]);
    const two = await run("admin", "sales_documents", "group=customerName,status");
    expect([two.status, two.body.code]).toEqual([400, "report_group_not_supported"]);
    // without a grouping nothing is totalled
    const plain = ok(await run("admin", "sales_documents", "columns=documentNumber"));
    expect([plain.groupedBy ?? null, plain.groups ?? null, plain.grandTotal ?? null]).toEqual([null, null, null]);
  });

  it("🔴 VAT lines by box: each box's VAT is the return's own box", async () => {
    const d = ok(await run("accountant", "vat_lines", "group=vatBox"));
    const ret = ok(await h.api("admin", "GET", "/reports/vat-return?period_from=2026-10&period_to=2026-10"));
    const box6 = d.groups.find((g: any) => g.key === "6");
    expect(totalOf(box6, "vat")).toBe(ret.salesSection.box6_vatOnStandardRatedSales);
    expect(totalOf(box6, "vat")).toBeGreaterThan(0);
  });

  it("🔴 a saved report keeps its grouping, refuses one the data does not offer, and its CSV carries the subtotals", async () => {
    const body = { name: "S7 sales by customer", dataset: "sales_documents", columns: ["customerName", "documentNumber", "signedTotal"], period: { kind: "fixed", from: "2026-10-01", to: "2026-10-31" }, groupBy: "customerName" };
    const saved = ok(await h.api("accountant", "POST", "/report-definitions", body), 201);
    expect(saved.groupBy).toBe("customerName");
    expect(ok(await h.api("accountant", "GET", `/report-definitions/${saved.id}`)).groupBy).toBe("customerName");
    const bad = await h.api("accountant", "POST", "/report-definitions", { ...body, name: "S7 bad", groupBy: "documentNumber" });
    expect([bad.status, bad.body.code]).toEqual([400, "report_group_not_supported"]);
    const cleared = ok(await h.api("accountant", "PUT", `/report-definitions/${saved.id}`, { ...body, groupBy: null }));
    expect(cleared.groupBy).toBeNull();

    const grouped = ok(await run("accountant", "sales_documents", "group=customerName&columns=customerName,documentNumber,signedTotal"));
    const csv = await h.api("accountant", "GET", `/reports/datasets/sales_documents/export?${WINDOW}&group=customerName&columns=customerName,documentNumber,signedTotal`);
    expect(csv.status, csv.text).toBe(200);
    const lines = csv.text.split(/\r?\n/);
    const beta = lines.find((l) => l.includes("Subtotal") && l.includes("S7 Beta"));
    expect(beta, csv.text).toBeTruthy();
    expect(beta).toContain(totalOf(grouped.groups[1], "signedTotal")!.toFixed(2));
    const grand = lines.find((l) => l.startsWith("Total") || l.includes(",Total") || l.includes("Total,"));
    expect(grand, csv.text).toContain(totalOf(grouped.grandTotal, "signedTotal")!.toFixed(2));
  });

  it("🔴 a scheduled grouped report: each recipient's stored copy carries the same subtotals, group by group — the screen, the file and the copy agree", async () => {
    const body = { name: "S7 scheduled by customer", dataset: "sales_documents", columns: ["customerName", "documentNumber", "signedTotal"], period: { kind: "fixed", from: "2026-10-01", to: "2026-10-31" }, groupBy: "customerName", sort: "-documentNumber" };
    const saved = ok(await h.api("accountant", "POST", "/report-definitions", body), 201);
    ok(await h.api("accountant", "POST", "/report-schedules", { definitionId: saved.id, cadence: "daily" }), 201);
    const { reportSchedulesJob } = await import("../services/reporting/reportSchedules.job");
    const result = await reportSchedulesJob.runOnce(new Date("2026-11-02T09:00:00Z"), orgId);
    expect([result.delivered, result.refused, result.failed]).toEqual([1, 0, 0]);
    const copies = ok(await h.api("accountant", "GET", "/report-deliveries")).items as { id: number; reportName: string }[];
    const copy = copies.find((c) => c.reportName === body.name)!;
    const opened = ok(await h.api("accountant", "GET", `/report-deliveries/${copy.id}`));
    const live = ok(await run("accountant", "sales_documents", "group=customerName&sort=-documentNumber&columns=customerName,documentNumber,signedTotal"));
    expect(opened.groupedBy).toBe("customerName");
    expect(opened.groups).toEqual(live.groups);
    expect(opened.grandTotal).toEqual(live.grandTotal);
    expect(totalOf(opened.grandTotal, "signedTotal")).toBeGreaterThan(0);
    expect(opened.rows.sales_documents.map((r: any) => r.customerName)).toEqual(live.rows.map((r: any) => r.customerName));
    // a report that is not grouped has no subtotals in its copy
    const flat = ok(await h.api("accountant", "POST", "/report-definitions", { ...body, name: "S7 scheduled flat", groupBy: null }), 201);
    ok(await h.api("accountant", "POST", "/report-schedules", { definitionId: flat.id, cadence: "daily" }), 201);
    await reportSchedulesJob.runOnce(new Date("2026-11-02T09:05:00Z"), orgId);
    const flatCopy = (ok(await h.api("accountant", "GET", "/report-deliveries")).items as { id: number; reportName: string }[]).find((c) => c.reportName === "S7 scheduled flat")!;
    const flatOpened = ok(await h.api("accountant", "GET", `/report-deliveries/${flatCopy.id}`));
    expect([flatOpened.groupedBy, flatOpened.groups, flatOpened.grandTotal]).toEqual([null, null, null]);
  });
});
