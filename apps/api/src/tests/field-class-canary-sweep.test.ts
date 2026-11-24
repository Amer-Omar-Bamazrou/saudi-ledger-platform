/**
 * 🔴 19B review follow-up, item 5 (owner, 2026-11-24) — THE CANARY SWEEP. "The review finds fields by name": a field the
 * class table never names, a nested copy, a free-text echo would pass it. So: plant a UNIQUE value in every protected
 * field, call EVERY GET route as a viewer and as a bookkeeper, and assert no canary appears ANYWHERE in a response the
 * role may not read it in — nested fields and free text included (the raw response text is scanned, not the JSON's
 * named fields).
 *
 *  - Which role may read a canary is the MATRIX's answer (`field.<class>.read` on its resource), so the same sweep runs
 *    for S2a's classes now and — primed with S2b's and S2c's planned removals — for theirs (`SWEEP_MATRICES`). S2b's
 *    are primed (S2B_REMOVALS), with a supplier paid with tax withheld so the withholding-tax routes carry its
 *    address (D9 d).
 *  - 🔴 NOT VACUOUS: every canary must be FOUND by the admin on at least one route (a canary nobody can see proves no
 *    withholding), and the sweep must have exercised a floor of routes; the routes it could not fill (a path
 *    parameter it has no record for) are counted and printed — the frame beside the result.
 *  - Payroll is run over TWO employees: a one-employee run's totals are that person's pay, which v4 §5.4 accepts and
 *    names; two keep the totals from equalling a canary.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3244";
process.env.SESSION_SECRET ??= "field-class-canary-sweep-000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX, S2B_REMOVALS, S2C_PENDING_REMOVALS, fieldGrantAction, type PermissionRow, type ProtectedFieldClass } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { CONTRACT } from "../lib/fieldClasses/contractShapes.generated";
import { OUTSIDE_CONTRACT_ROUTES } from "../lib/fieldClasses/outsideContract";
import { EXPORTABLE_REPORTS } from "../services/reporting/reportExport.service";
import { approveHeldIbans } from "./helpers/approveHeldIbans";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "field-class-canary-sweep-password";
const h = g04Harness("canary");

function saIban(bban: string): string {
  const n = BigInt(`${bban}281000`);
  return `SA${String(98n - (n % 97n)).padStart(2, "0")}${bban}`;
}

/** Every planted value, with the class and resource that protect it. `also`: other forms of the same secret. */
type Canary = { what: string; value: string; cls: ProtectedFieldClass; resource: string; also?: string[] };
const EMP_IBAN = saIban("60000000771234509876");
const SUP_IBAN = saIban("70000000881234598765");
const CANARIES: Canary[] = [
  // S2a — employees and payroll
  { what: "employee national ID", value: "1093771456", cls: "identity", resource: "employees" },
  { what: "employee GOSI number", value: "GOSI-CANARY-77104", cls: "identity", resource: "employees" },
  { what: "employee IBAN", value: EMP_IBAN, cls: "bank_account", resource: "employees", also: [EMP_IBAN.slice(0, -4)] },
  { what: "employee basic salary", value: "9137.43", cls: "compensation", resource: "employees" },
  { what: "employee housing allowance", value: "2861.19", cls: "compensation", resource: "employees" },
  { what: "employee notes", value: "CANARY-EMP-NOTE-51203", cls: "compensation", resource: "employees" },
  // S2b — customers and suppliers (every role reads them until S2b's removals)
  { what: "customer national ID", value: "1084215573", cls: "identity", resource: "customers" },
  { what: "customer phone", value: "+966500071399", cls: "contact", resource: "customers" },
  { what: "customer email", value: "canary.customer.88@example.sa", cls: "contact", resource: "customers" },
  { what: "customer address", value: "CANARY-STREET-77120", cls: "contact", resource: "customers" },
  { what: "customer street (printed on the invoice)", value: "CANARY-CUST-STREET-55121", cls: "contact", resource: "customers" },
  { what: "supplier phone", value: "+966500082411", cls: "contact", resource: "vendors" },
  { what: "supplier email", value: "canary.supplier.41@example.sa", cls: "contact", resource: "vendors" },
  { what: "supplier address (on the withholding-tax return)", value: "CANARY-SUPP-ADDR-66120", cls: "contact", resource: "vendors" },
  { what: "supplier IBAN", value: SUP_IBAN, cls: "bank_account", resource: "vendors", also: [SUP_IBAN.slice(0, -4)] },
  // S2c — the bank's own text
  { what: "bank line text", value: "CANARY-BANKTEXT-33917", cls: "bank_narrative", resource: "journal_entries" },
];

/** The matrices the sweep runs under: today's (S2a's classes switched on). S2b and S2c add their planned removals. */
const S2B_PENDING = new Set(S2B_REMOVALS.map((r) => `${r.role}:${r.resource}:${r.action}`));
const S2C_PENDING = new Set(S2C_PENDING_REMOVALS.map((r) => `${r.role}:${r.resource}:${r.action}`));
const SWEEP_MATRICES: Array<{ name: string; rows: PermissionRow[] }> = [
  // Restated for the S2b removal: the matrix itself lacks S2a's and S2b's removals (the S2b filter is now the identity
  // and stays, so the sweep keeps naming S2b's set); S2c's planned removals are primed on top of it.
  { name: "the current matrix (S2a + S2b)", rows: PERMISSION_MATRIX.filter((r) => !S2B_PENDING.has(`${r.role}:${r.resource}:${r.action}`)) },
  // 19B S2c: its nine planned removals primed ON TOP of S2b's (the bank's text, member security, migration contact)
  { name: "S2b's and S2c's planned removals", rows: PERMISSION_MATRIX.filter((r) => !S2B_PENDING.has(`${r.role}:${r.resource}:${r.action}`) && !S2C_PENDING.has(`${r.role}:${r.resource}:${r.action}`)) },
];

const ROLES_SWEPT = ["viewer", "bookkeeper"] as const;
const SKIP = [/\/logout/, /\/llm\//, /\/pdf/, /\/document(\/|$)/, /\/stream/, /\/download/];

describeDb("19B — the canary sweep: no protected value reaches a role that may not read it, on any GET route", () => {
  let orgId = "";
  const ids: Record<string, number | string> = {};
  const routes: { key: string; path: string }[] = [];
  const unresolved: string[] = [];

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    ids.org = orgId;
    await h.mkCompany(orgId, "Canary Co", "319191919191973");
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) await h.mkUser(role, PW, orgId, role);
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) expect(await h.login(role, h.email(role), PW)).toBe(200);
    const ok = async (who: string, method: string, path: string, body?: unknown) => {
      const r = await h.api(who, method, path, body);
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
      return r.body;
    };
    const c = (what: string) => CANARIES.find((x) => x.what === what)!.value;
    // employees: the canaried one and an ordinary one (two, so the run's totals are no one's pay)
    ids.emp = (await ok("accountant", "POST", "/employees", {
      employeeNumber: "CAN-E1", name: "Canary Employee", jobTitle: "Clerk", department: "Finance", nationality: "SA", gosiRegime: "law_1421h", gosiRegimeBasis: "certificate",
      nationalId: c("employee national ID"), gosiNumber: c("employee GOSI number"), iban: EMP_IBAN,
      basicSalary: Number(c("employee basic salary")), housingAllowance: Number(c("employee housing allowance")), transportAllowance: 400,
      notes: c("employee notes"), joiningDate: "2025-01-01",
    })).id;
    await ok("accountant", "POST", "/employees", { employeeNumber: "CAN-E2", name: "Ordinary Employee", jobTitle: "Driver", department: "Ops", nationality: "SA", gosiRegime: "law_1421h", gosiRegimeBasis: "certificate", nationalId: "1022334455", basicSalary: 4000, housingAllowance: 1000, transportAllowance: 300, joiningDate: "2025-01-01" });
    ids.run = (await ok("accountant", "POST", "/payroll", { period: "2026-10" })).id;
    // customers and suppliers
    ids.cust = (await ok("accountant", "POST", "/customers", { name: "Canary Customer", nationalId: c("customer national ID"), phone: c("customer phone"), email: c("customer email"), address: c("customer address"), street: c("customer street (printed on the invoice)"), city: "Riyadh" })).id;
    ids.vendor = (await ok("accountant", "POST", "/vendors", { name: "Canary Supplier", residency: "resident", phone: c("supplier phone"), email: c("supplier email"), iban: SUP_IBAN })).id;
    expect(await approveHeldIbans(h, "admin")).toBe(2); // the employee's and the supplier's IBANs, held at entry (S3)
    // documents that name them: a draft invoice to the canary customer, a draft bill from the canary supplier
    ids.inv = (await ok("accountant", "POST", "/invoices", { date: "2026-10-05", customerId: ids.cust, items: [{ description: "Services", quantity: 1, unitPrice: 1000, vatRate: 15 }] })).id;
    ids.bill = (await ok("accountant", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: "CAN-R-1", billNumber: "CAN-B-1", date: "2026-10-06", dueDate: "2026-10-06", vendorId: ids.vendor, items: [{ description: "Supplies", quantity: 1, unitPrice: 500, vatRate: 15 }] })).id;
    // the bank's own text: a bank row posted from a transaction
    const acct = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
    ids.bank = (await ok("admin", "POST", "/bank-accounts", { name: "Canary Ops", bankName: "SNB", currency: "SAR" })).id;
    ids.txn = (await ok("admin", "POST", "/transactions", { date: "2026-10-10", description: c("bank line text"), amount: 120, currency: "SAR", type: "debit", categoryId: await acct("RENT_UTILITIES"), bankAccountId: ids.bank })).id;
    // 19B S2b (D9 d): a non-resident supplier with an address, paid with tax withheld — so the withholding-tax return,
    // schedule, annual return, beneficiary statement and the withholding itself all name its address
    ids.overseas = (await ok("accountant", "POST", "/vendors", { name: "Canary Overseas", residency: "non_resident", whtDefaultPaymentType: "technical_consulting", country: "GB", address: c("supplier address (on the withholding-tax return)"), city: "London" })).id;
    const wBill = await ok("admin", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: "CAN-R-W", billNumber: "CAN-B-W", date: "2026-10-12", dueDate: "2026-10-12", vendorId: ids.overseas, items: [{ description: "Consulting", quantity: 1, unitPrice: 10_000, vatRate: 0 }] });
    await ok("admin", "POST", `/bills/${wBill.id}/approve`, {});
    await ok("admin", "POST", `/bills/${wBill.id}/pay`, { amount: 10_000, paidAt: "2026-10-12", bankAccountId: ids.bank });
    ids.wht = (await pool.query(`SELECT id FROM wht_withholdings WHERE bill_id = $1`, [wBill.id])).rows[0].id;
    ids.je = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND source_type = 'bank_transaction' LIMIT 1`, [orgId])).rows[0].id;

    // every GET route: the contract's and those outside it, each path parameter filled from the planted records
    const fill: Array<[RegExp, Record<string, () => number | string>]> = [
      [/^\/employees\//, { id: () => ids.emp! }],
      [/^\/payroll\//, { id: () => ids.run! }],
      [/^\/customers\//, { id: () => ids.cust! }],
      [/^\/vendors\//, { id: () => ids.vendor! }],
      [/^\/supplier-statements\//, { vendorId: () => ids.vendor! }],
      [/^\/journal-entries\//, { id: () => ids.je! }],
      [/^\/transactions\//, { id: () => ids.txn! }],
      [/^\/bank-accounts\//, { id: () => ids.bank! }],
      [/^\/orgs\//, { orgId: () => orgId }],
      [/^\/invoices\//, { id: () => ids.inv! }],
      [/^\/bills\//, { id: () => ids.bill! }],
      [/^\/tax\/wht\/beneficiaries\//, { vendorId: () => ids.overseas! }],
      [/^\/tax\/wht\/returns\//, { period: () => "2026-10" }],
      [/^\/tax\/wht\/withholdings\//, { id: () => ids.wht! }],
    ];
    const keys = [
      ...CONTRACT.operations.filter((op) => op.method === "GET").map((op) => op.path),
      ...Object.keys(OUTSIDE_CONTRACT_ROUTES).filter((k) => k.startsWith("GET ")).map((k) => k.slice(4)),
    ];
    for (const key of [...new Set(keys)]) {
      if (SKIP.some((re) => re.test(key))) continue;
      // every report export, as CSV (a PDF needs the renderer CI does not have): exports carry addresses and bank text
      if (key === "/reports/export/{report}") {
        for (const report of EXPORTABLE_REPORTS) routes.push({ key: `${key} (${report})`, path: `/reports/export/${report}?format=csv&date_from=2026-01-01&date_to=2026-12-31` });
        continue;
      }
      const params = [...key.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      const rule = fill.find(([re]) => re.test(key))?.[1];
      if (params.some((p) => !rule?.[p])) { unresolved.push(key); continue; }
      const path = key.replace(/\{(\w+)\}/g, (_, p: string) => String(rule![p]!()));
      routes.push({ key, path: `${path}${path.includes("?") ? "&" : "?"}date_from=2026-01-01&date_to=2026-12-31` });
    }
  }, 180_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  const seen = async (who: string) => {
    const found = new Map<string, string[]>(); // canary → routes it appeared in
    let answered = 0;
    for (const r of routes) {
      const res = await h.api(who, "GET", r.path);
      if (res.status < 500) answered++;
      for (const c of CANARIES) for (const v of [c.value, ...(c.also ?? [])]) if (res.text.includes(v)) found.set(c.what, [...(found.get(c.what) ?? []), `${r.key}${v === c.value ? "" : " (partial)"}`]);
    }
    return { found, answered };
  };

  it("the frame: every GET route with no path parameter is swept; the ones with a parameter it cannot fill are named", () => {
    console.log(`[CANARY-SWEEP] ${routes.length} GET routes swept; ${unresolved.length} not filled: ${unresolved.join(", ")}`);
    const swept = new Set(routes.map((r) => r.key));
    const noParam = [...CONTRACT.operations.filter((op) => op.method === "GET").map((op) => op.path), ...Object.keys(OUTSIDE_CONTRACT_ROUTES).filter((k) => k.startsWith("GET ")).map((k) => k.slice(4))]
      .filter((k) => !k.includes("{") && !SKIP.some((re) => re.test(k)));
    expect(noParam.length).toBeGreaterThan(80); // the enumeration itself is not broken
    expect(noParam.filter((k) => !swept.has(k))).toEqual([]);
    // and every route that can serve a planted record's own fields is filled
    for (const k of ["/employees/{id}", "/payroll/{id}", "/customers/{id}", "/vendors/{id}", "/invoices/{id}", "/bills/{id}", "/journal-entries/{id}", "/transactions/{id}"]) expect([k, swept.has(k)]).toEqual([k, true]);
  });

  it("🔴 NOT VACUOUS: the admin finds every canary on at least one route", async () => {
    primePermissionCache(PERMISSION_MATRIX);
    const { found } = await seen("admin");
    expect(CANARIES.filter((c) => !found.has(c.what)).map((c) => c.what)).toEqual([]);
  }, 300_000);

  for (const m of SWEEP_MATRICES) {
    it(`🔴 under ${m.name}: no canary reaches a viewer or a bookkeeper that may not read it — anywhere in any response`, async () => {
      primePermissionCache(m.rows);
      const grants = new Set(m.rows.map((r) => `${r.role}:${r.resource}:${r.action}`));
      const leaks: string[] = [];
      for (const role of ROLES_SWEPT) {
        const { found, answered } = await seen(role);
        expect([role, answered]).toEqual([role, routes.length]); // every route answered (a 5xx would hide a body)
        for (const c of CANARIES) {
          const mayRead = grants.has(`${role}:${c.resource}:${fieldGrantAction(c.cls, "read")}`);
          if (!mayRead && found.has(c.what)) leaks.push(`${role} — ${c.what} (${c.cls} on ${c.resource}): ${found.get(c.what)!.join("; ")}`);
        }
      }
      expect(leaks).toEqual([]);
      primePermissionCache(PERMISSION_MATRIX);
    }, 300_000);
  }
});
