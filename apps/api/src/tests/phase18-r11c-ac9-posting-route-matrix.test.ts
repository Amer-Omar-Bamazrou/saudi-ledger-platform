/**
 * 🔴 Phase 18 R-11c — AC-9 (owner, 2026-11-01, memo §3): "the posting route × role matrix test, after DR-20."
 * Register §11.111.
 *
 *  1. THE CENSUS IS DERIVED, AND IT MATCHES THIS TABLE BOTH WAYS. `helpers/postingRouteCensus` follows the code's
 *     own calls from every route to the units that flip a journal entry to posted. A posting route the table does not
 *     list fails this file; so does a table row the census no longer finds. The flip units themselves are pinned: a new
 *     place that posts must be looked at, not absorbed.
 *  2. EVERY POSTING ROUTE × EVERY ROLE, over HTTP: the permission layer refuses exactly the roles the matrix does not
 *     grant the route's resource and action (`requires_approval_authority`), and lets the others through to the
 *     route's own checks. The operator surface refuses every tenant role.
 *  3. EVERY POSTING ROUTE A BOOKKEEPER MAY CALL, with a real posting (DR-20, R-11b): by what it touches — a cash, tax
 *     or equity posting refused (403 `approver_required`) with two approvers and posted and flagged with one; a posting
 *     touching none of the three posted, unflagged, in both.
 *
 * DB-backed (sl_test / CI); the census half runs everywhere.
 */
process.env.PORT ??= "3223";
process.env.SESSION_SECRET ??= "r11c-ac9-posting-route-matrix-000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { createApproved } from "./helpers/createApproved";
import { postingRouteCensus, type Census } from "./helpers/postingRouteCensus";
import { bankAccountsService } from "../services/bankAccounts.service";
import { transactionsService } from "../services/transactions.service";
import { billsService } from "../services/bills.service";
import { invoicesService } from "../services/invoices.service";
import { recognitionSchedulesService } from "../services/accounting/recognitionSchedules.service";
import { assetsService } from "../services/assets.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "R11cMatrixPw123!";
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
type Role = (typeof ROLES)[number];

/**
 * Every route that can post, with the permission it is guarded by (the mount's resource and the action the
 * permission layer reads: GET read, POST create — or `approve` on an activation path — PUT/PATCH update,
 * DELETE delete). `null` resource: the platform operator's surface, which no tenant role reaches.
 */
const POSTING_ROUTES: Array<{ method: string; path: string; resource: string | null; action: string | null }> = [
  { method: "POST", path: "/assets/:id/depreciate", resource: "assets", action: "create" },
  { method: "POST", path: "/assets/:id/dispose", resource: "assets", action: "create" },
  { method: "POST", path: "/assets/depreciation-runs", resource: "assets", action: "create" },
  { method: "POST", path: "/bank-transfers", resource: "transactions", action: "create" },
  { method: "POST", path: "/bank-transfers/:id/reverse", resource: "transactions", action: "approve" },
  { method: "POST", path: "/bills/:id/approve", resource: "bills", action: "approve" },
  { method: "POST", path: "/bills/:id/evidence", resource: "bills", action: "create" },
  { method: "POST", path: "/bills/:id/pay", resource: "bills", action: "approve" },
  { method: "POST", path: "/bills/:id/post", resource: "bills", action: "approve" },
  { method: "POST", path: "/bills/:id/vat-figures-confirmation", resource: "bills", action: "approve" },
  { method: "POST", path: "/invoices/:id/approve", resource: "invoices", action: "approve" },
  { method: "POST", path: "/invoices/:id/bad-debt-relief", resource: "invoices", action: "approve" },
  { method: "POST", path: "/invoices/:id/pay", resource: "invoices", action: "approve" },
  { method: "POST", path: "/journal-entries/:id/approve", resource: "journal_entries", action: "approve" },
  { method: "POST", path: "/journal-entries/:id/post", resource: "journal_entries", action: "approve" },
  { method: "POST", path: "/journal-entries/:id/reverse", resource: "journal_entries", action: "approve" },
  { method: "POST", path: "/migration/batches/:id/commit", resource: "migration", action: "create" },
  { method: "POST", path: "/migration/batches/:id/reverse", resource: "migration", action: "approve" },
  { method: "POST", path: "/migration/open-items/:itemId/correct", resource: "migration", action: "create" },
  { method: "POST", path: "/operator/zatca/jobs/:name/run", resource: null, action: null },
  { method: "POST", path: "/payments", resource: "payments", action: "create" },
  { method: "POST", path: "/payments/:id/allocate", resource: "payments", action: "approve" },
  { method: "POST", path: "/payments/:id/classify", resource: "payments", action: "create" },
  { method: "POST", path: "/payments/allocations/:id/unallocate", resource: "payments", action: "approve" },
  { method: "POST", path: "/payments/credit-notes/:id/apply", resource: "payments", action: "approve" },
  { method: "POST", path: "/payments/refunds", resource: "payments", action: "create" },
  { method: "POST", path: "/payroll/:id/approve", resource: "payroll", action: "approve" },
  { method: "POST", path: "/payroll/:id/gosi/pay", resource: "payroll", action: "approve" },
  { method: "POST", path: "/payroll/:id/pay", resource: "payroll", action: "approve" },
  { method: "POST", path: "/recognition-schedules/:id/recognise", resource: "journal_entries", action: "create" },
  { method: "POST", path: "/recognition-schedules/runs", resource: "journal_entries", action: "create" },
  { method: "POST", path: "/supplier-payments", resource: "payments", action: "create" },
  { method: "POST", path: "/supplier-payments/:id/allocate", resource: "payments", action: "approve" },
  { method: "POST", path: "/supplier-payments/:id/classify", resource: "payments", action: "create" },
  { method: "POST", path: "/supplier-payments/:id/refund", resource: "payments", action: "create" },
  { method: "POST", path: "/supplier-payments/allocations/:id/reverse", resource: "payments", action: "approve" },
  { method: "POST", path: "/tax/computations/:id/versions/:versionId/approve", resource: "tax", action: "approve" },
  { method: "POST", path: "/tax/vat-return-filings", resource: "tax", action: "create" },
  { method: "POST", path: "/tax/wht/periods/:period/pay", resource: "tax", action: "approve" },
  { method: "POST", path: "/tax/wht/remittances/:id/reverse", resource: "tax", action: "approve" },
  { method: "POST", path: "/tax/wht/withholdings/:id/reverse", resource: "tax", action: "approve" },
  { method: "POST", path: "/transactions", resource: "transactions", action: "create" },
  { method: "DELETE", path: "/transactions/:id", resource: "transactions", action: "delete" },
  { method: "PATCH", path: "/transactions/:id", resource: "transactions", action: "update" },
  { method: "POST", path: "/transactions/:id/settle", resource: "transactions", action: "approve" },
  { method: "POST", path: "/transactions/review/accept", resource: "transactions", action: "create" },
  { method: "POST", path: "/treasury/payment-plans/:id/pay", resource: "treasury", action: "approve" },
];
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
/** The three places that flip a journal entry to posted — the seam, the generic reverse's mirror, the manual approval. */
const FLIP_UNITS = ["services/accounting/glPosting.ts", "services/journalEntries.approvable.ts", "services/journalEntries.service.ts"];
const granted = (role: Role, resource: string, action: string) => PERMISSION_MATRIX.some((p) => p.role === role && p.resource === resource && p.action === action);
const concrete = (path: string) => path.replace(/:period/g, "2026-01").replace(/:name/g, "r11c-none").replace(/:[a-zA-Z]+/g, "999999999");

let census: Census;

describe("R-11c (AC-9) — the census of posting routes is derived from the code, and matches the table both ways", () => {
  beforeAll(() => { census = postingRouteCensus(); }, 240_000);

  it("🔴 the flip units are the three known places — a new place that posts is looked at, not absorbed", () => {
    expect(census.flipUnits.map((u) => u.replace(/:\d+$/, ""))).toEqual(FLIP_UNITS);
  });
  it("🔴 the census sees the routes (an instrument that sees none proves nothing)", () => {
    expect(census.routesSeen, "route registrations seen").toBeGreaterThan(300);
    expect(census.routes.map(key), "a known posting route").toContain("POST /bills/:id/pay");
  });
  it("🔴 every posting route the code has is in the table", () => {
    const table = new Set(POSTING_ROUTES.map(key));
    expect(census.routes.map(key).filter((k) => !table.has(k))).toEqual([]);
  });
  it("🔴 every table row is a posting route the code still has", () => {
    const found = new Set(census.routes.map(key));
    expect(POSTING_ROUTES.map(key).filter((k) => !found.has(k))).toEqual([]);
  });
  it("🔴 the table's resource is the one the route is mounted under", () => {
    const byKey = new Map(census.routes.map((r) => [key(r), r.resources]));
    const wrong = POSTING_ROUTES.filter((r) => (r.resource ? !(byKey.get(key(r)) ?? []).includes(r.resource) : (byKey.get(key(r)) ?? []).length !== 0)).map(key);
    expect(wrong).toEqual([]);
  });
});

describeMaybe("R-11c (AC-9) — every posting route × every role, over HTTP, as the matrix says", () => {
  const h = g04Harness("r11cmatrix");
  let orgId = "";

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "R11c Matrix Co", "319191919194003");
    for (const r of ROLES) await h.mkUser(r, PW, orgId, r);
    await h.start();
    for (const r of ROLES) expect(await h.login(r, h.email(r), PW), `login ${r}`).toBe(200);
  }, 180_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  for (const route of POSTING_ROUTES) {
    it(`${key(route)}: refused to exactly the roles the matrix does not grant ${route.resource ?? "(operator surface)"}${route.action ? `:${route.action}` : ""}`, async () => {
      const verdicts: Record<string, string> = {};
      for (const role of ROLES) {
        const r = await h.api(role, route.method, concrete(route.path), {});
        const refusedByPermission = r.status === 403 && (route.resource === null || r.body?.code === "requires_approval_authority");
        const expectRefused = route.resource === null || !granted(role, route.resource, route.action!);
        verdicts[role] = `${refusedByPermission ? "refused" : "passed"}${refusedByPermission === expectRefused ? "" : ` (expected ${expectRefused ? "refused" : "passed"}; ${r.status} ${JSON.stringify(r.body).slice(0, 120)})`}`;
      }
      const expected = Object.fromEntries(ROLES.map((role) => [role, route.resource === null || !granted(role, route.resource, route.action!) ? "refused" : "passed"]));
      expect(verdicts).toEqual(expected);
    });
  }
});

/** The posting routes the matrix lets a bookkeeper call — part 3 posts through each one. */
const BOOKKEEPER_POSTING_ROUTES = POSTING_ROUTES.filter((r) => r.resource && granted("bookkeeper", r.resource, r.action!)).map(key).sort();

describeMaybe("R-11c (AC-9) — every posting route a bookkeeper may call, posting for real: by what it touches (DR-20)", () => {
  const h = g04Harness("r11cbook");
  type Org = { key: "two" | "one"; id: string; co: string; admin: number; keeper: number; b1: number; b2: number; leaf: number; vendor: number; customer: number };
  const two = { key: "two" } as Org; // admin + accountant + bookkeeper: refused
  const one = { key: "one" } as Org; // admin + bookkeeper: flagged
  const covered = new Set<string>();
  let seq = 0;
  const run = (o: Org) => <T,>(fn: () => Promise<T>) => h.inTenant(o.id, o.co, o.admin, fn);
  const acct = async (o: Org, code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [o.id, code])).rows[0].id as number;
  const entries = async (o: Org) => Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [o.id])).rows[0].n);
  const flags = async (o: Org) => Number((await pool.query(`SELECT count(*)::int n FROM control_flags WHERE organization_id = $1 AND kind = 'unreviewed_posting'`, [o.id])).rows[0].n);
  const keeper = (o: Org, method: string, path: string, body: unknown) => h.api(`keeper-${o.key}`, method, path, body);

  /** The DR-20 verdict for one call in each organisation, by the class it touches. */
  async function byFact(route: string, touches: boolean, prepare: (o: Org) => Promise<() => Promise<{ status: number; body: any }>>, ok: number) {
    covered.add(route);
    for (const o of [two, one]) {
      const call = await prepare(o); // the fixture first, as the admin; then the count; then the bookkeeper's request
      const [e0, f0] = [await entries(o), await flags(o)];
      const r = await call();
      if (touches && o === two) {
        expect([r.status, r.body?.code], `${route} (two approvers): ${JSON.stringify(r.body).slice(0, 200)}`).toEqual([403, "approver_required"]);
        expect(await entries(o), "nothing posted").toBe(e0);
      } else {
        expect(r.status, `${route} (${o.key}): ${JSON.stringify(r.body).slice(0, 200)}`).toBe(ok);
        expect(await entries(o), "it posted").toBeGreaterThan(e0);
        if (touches) expect(await flags(o), "flagged (one approver)").toBeGreaterThan(f0);
        else expect(await flags(o), "a posting touching no cash, tax or equity is not flagged").toBe(f0);
      }
    }
  }

  beforeAll(async () => {
    await h.cleanup();
    for (const [o, vat] of [[two, "319191919195003"], [one, "319191919195103"]] as const) {
      o.id = await h.mkOrg(o.key);
      o.co = await h.mkCompany(o.id, `R11c ${o.key}`, vat);
      o.admin = await h.mkUser(`${o.key}-admin`, PW, o.id, "admin");
      o.keeper = await h.mkUser(`${o.key}-keeper`, PW, o.id, "bookkeeper");
      if (o === two) await h.mkUser(`${o.key}-accountant`, PW, o.id, "accountant");
      o.b1 = (await run(o)(() => bankAccountsService.create({ name: `R11c ${o.key} B1`, bankName: "SNB", currency: "SAR" }))).id as number;
      o.b2 = (await run(o)(() => bankAccountsService.create({ name: `R11c ${o.key} B2`, bankName: "SNB", currency: "SAR" }))).id as number;
      o.leaf = (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [o.b1])).rows[0].id;
      o.vendor = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'R11c Supplier','300000000000003') RETURNING id`, [o.id])).rows[0].id;
      o.customer = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'R11c Customer') RETURNING id`, [o.id])).rows[0].id;
    }
    await h.start();
    for (const o of [two, one]) expect(await h.login(`keeper-${o.key}`, h.email(`${o.key}-keeper`), PW), `login ${o.key} bookkeeper`).toBe(200);
  }, 180_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  // Each case builds its fixture as the admin, then hands back the bookkeeper's one request (measured on its own).
  it("POST /bank-transfers — cash", () => byFact("POST /bank-transfers", true,
    async (o) => () => keeper(o, "POST", "/bank-transfers", { fromBankAccountId: o.b1, toBankAccountId: o.b2, amount: 51, transferDate: "2026-10-01" }), 200));

  it("POST /transactions (a manual bank row with a category) — cash", () => byFact("POST /transactions", true, async (o) => {
    const rent = await acct(o, "RENT_UTILITIES");
    return () => keeper(o, "POST", "/transactions", { date: "2026-10-10", description: "R11c rent", amount: 120, currency: "SAR", type: "debit", categoryId: rent, bankAccountId: o.b1 });
  }, 201));

  it("POST /transactions/review/accept (a pending statement line) — cash", () => byFact("POST /transactions/review/accept", true, async (o) => {
    const desc = `R11C PENDING ${++seq}`;
    await run(o)(() => transactionsService.upload({ rows: [{ date: "2026-10-12", description: desc, amount: 77, currency: "SAR", type: "debit" }], autoCategrize: false, bankAccountId: o.b1 } as never, o.admin));
    const id = (await pool.query(`SELECT id FROM transactions WHERE organization_id = $1 AND description LIKE $2`, [o.id, `${desc}%`])).rows[0].id;
    return () => keeper(o, "POST", "/transactions/review/accept", { ids: [id] });
  }, 200));

  it("PATCH /transactions/:id (re-categorising a posted bank row: its reversal and its repost) — cash", () => byFact("PATCH /transactions/:id", true, async (o) => {
    const row = await run(o)(async () => transactionsService.create({ date: "2026-10-11", description: `R11c row ${++seq}`, amount: 130 + seq, currency: "SAR", type: "debit", categoryId: await acct(o, "RENT_UTILITIES"), bankAccountId: o.b1 } as never)) as { id: number };
    const other = await acct(o, "OTHER_EXPENSES");
    return () => keeper(o, "PATCH", `/transactions/${row.id}`, { categoryId: other });
  }, 200));

  it("POST /bills/:id/evidence (claiming a bill's held input VAT) — tax", () => byFact("POST /bills/:id/evidence", true, async (o) => {
    const b = await run(o)(() => billsService.create({ vendorId: o.vendor, vendorReference: `R11C-INV-${++seq}`, date: "2026-10-05", subtotal: 1000, vatAmount: 150, total: 1150, items: [] } as never, o.admin)) as { id: number };
    await run(o)(() => billsService.approve(b.id, {}, o.admin));
    return () => keeper(o, "POST", `/bills/${b.id}/evidence`, { supplierDocumentKind: "tax_invoice", evidenceDate: "2026-10-20" });
  }, 200));

  it("POST /tax/vat-return-filings (its clearing entry) — tax", () => byFact("POST /tax/vat-return-filings", true, async (o) => {
    await run(o)(() => createApproved(invoicesService, { invoiceNumber: `R11C-I-${++seq}`, date: "2026-09-15", dueDate: "2026-09-30", customerId: o.customer, items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] }, o.admin));
    return () => keeper(o, "POST", "/tax/vat-return-filings", { periodFrom: "2026-09", periodTo: "2026-09", filedOn: "2026-10-15", zatcaReference: `VAT-R11C-${o.key}` });
  }, 201));

  const schedule = async (o: Org, balance: "prepaid" | "bank") => {
    const s = await run(o)(async () => recognitionSchedulesService.create({ kind: "prepayment", totalAmount: 300, periods: 3, startPeriod: "2026-10", description: `R11c ${balance} ${++seq}`,
      expenseAccountId: await acct(o, "RENT_UTILITIES"), balanceAccountId: balance === "bank" ? o.leaf : await acct(o, "PREPAID_EXPENSES"), reference: `RS-R11C-${seq}` } as never, o.admin)) as { id: number };
    await run(o)(() => recognitionSchedulesService.activate(s.id, {} as never, o.admin));
    return s.id;
  };
  it("POST /recognition-schedules/:id/recognise — a prepayment: no cash, tax or equity, untouched", () => byFact("POST /recognition-schedules/:id/recognise", false, async (o) => {
    const s = await schedule(o, "prepaid");
    return () => keeper(o, "POST", `/recognition-schedules/${s}/recognise`, { period: "2026-10" });
  }, 200));
  it("POST /recognition-schedules/:id/recognise — a schedule drawn on a bank: cash", () => byFact("POST /recognition-schedules/:id/recognise", true, async (o) => {
    const s = await schedule(o, "bank");
    return () => keeper(o, "POST", `/recognition-schedules/${s}/recognise`, { period: "2026-10" });
  }, 200));

  it("POST /recognition-schedules/runs — the run posts each schedule in its own savepoint: a refused item is SKIPPED, by name, nothing posted for it; with one approver it posts, flagged", async () => {
    covered.add("POST /recognition-schedules/runs");
    for (const o of [two, one]) {
      const s = await schedule(o, "bank");
      const [e0, f0] = [await entries(o), await flags(o)];
      const r = await keeper(o, "POST", "/recognition-schedules/runs", { period: "2026-10" });
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
      const mine = (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1 AND source_type = 'recognition' AND source_id = $2`, [o.id, s])).rows[0].n;
      if (o === two) {
        expect(mine, "nothing posted for the refused schedule").toBe(0);
        expect(JSON.stringify(r.body.skipped ?? r.body), "the refusal is reported, not hidden").toMatch(/approver|refused/i);
      } else {
        expect(mine, "posted").toBeGreaterThan(0);
        expect(await flags(o), "flagged").toBeGreaterThan(f0);
      }
      void e0;
    }
  });

  const asset = async (o: Org) => {
    const cat = await run(o)(() => assetsService.createCategory({ name: `R11c PCs ${++seq}`, defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" } as never, o.admin)) as { id: number };
    const a = await run(o)(() => assetsService.create({ name: `R11c asset ${seq}`, categoryId: cat.id, acquisitionDate: "2026-10-01", availableForUseDate: "2026-10-01", cost: 12000, residualValue: 0, vatInputTaxAmount: 1800 } as never, o.admin)) as { id: number };
    const bl = await run(o)(() => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: `R11C-S-${seq}`, billNumber: `R11C-B-${seq}`, date: "2026-10-01", vendorId: o.vendor,
      subtotal: 12000, vatAmount: 1800, total: 13800, capitalisesAssetId: a.id, items: [{ description: "Asset", quantity: 1, unitPrice: 12000 }] } as never, o.admin)) as { id: number };
    await run(o)(() => billsService.approve(bl.id, {}, o.admin));
    return a.id;
  };
  it("POST /assets/:id/depreciate — no cash, tax or equity: untouched", () => byFact("POST /assets/:id/depreciate", false, async (o) => {
    const a = await asset(o);
    return () => keeper(o, "POST", `/assets/${a}/depreciate`, { period: "2026-10" });
  }, 200));
  it("POST /assets/depreciation-runs — no cash, tax or equity: untouched", () => byFact("POST /assets/depreciation-runs", false, async (o) => {
    await asset(o);
    return () => keeper(o, "POST", "/assets/depreciation-runs", { period: "2026-10" });
  }, 200));
  it("POST /assets/:id/dispose (scrapped) — no cash, tax or equity: untouched", () => byFact("POST /assets/:id/dispose", false, async (o) => {
    const a = await asset(o);
    return () => keeper(o, "POST", `/assets/${a}/dispose`, { date: "2026-10-20", kind: "scrapped", reason: "Damaged" });
  }, 200));

  it("🔴 every posting route a bookkeeper may call was posted through above (the list is the matrix's, not this file's)", () => {
    expect([...covered].sort()).toEqual(BOOKKEEPER_POSTING_ROUTES);
  });
});
