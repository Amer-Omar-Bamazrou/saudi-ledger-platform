/**
 * 🔴 19B S2a — EMPLOYEE AND PAYROLL MONEY AGGREGATES, WITH THE TWELVE GRANTS REMOVED (owner item 2, 2026-11-23).
 *
 * The rule: a money total over a set the caller chooses (search, department, status) is pay — withheld on the server
 * from a role without pay read, named in X-Withheld, never a zero or a null. Counts stay, except the two that state one
 * person's nationality or GOSI law. Totals over a fixed set — a whole run, the ledger — stay (D1), because the run's
 * journal entry already carries them. Inventory, endpoint by endpoint: evidence `s2a/aggregates-inventory.md`.
 *
 * The matrix here IS S2a's (PERMISSION_MATRIX lacks the twelve). For a VIEWER and a BOOKKEEPER, each aggregate below;
 * for an ACCOUNTANT and an ADMIN the same figure is served, and it IS the one person's pay — so every withholding is
 * shown to stop a real leak, not an empty one (presence, absence and movement).
 *
 * 🔴 STAND-IN, named: the report PDFs are built from HTML handed to the ONE renderer (`document/htmlToPdf`, Chromium).
 * Here that renderer is replaced by one that RECORDS the HTML and returns a fixed PDF, so the check is of exactly what
 * each PDF is built from, and it runs where Chromium is absent (CI's test job). The CSV is checked as served.
 *
 * Also (owner item 4): the contract's GET routes WITH a path parameter whose response can carry an identity, pay or
 * bank-account field, found from the class table (no hand list), and S2a's two of them as each role.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { CONTRACT } from "../lib/fieldClasses/contractShapes.generated";
import { FIELD_CLASS_TABLE } from "../lib/fieldClasses/classTable";
import type { Shape } from "../lib/fieldClasses/shapes";
import { EXPORTABLE_REPORTS } from "../services/reporting/reportExport.service";
import { g04Harness } from "./helpers/g04Harness";
import { approveHeldIbans } from "./helpers/approveHeldIbans";

const pdfHtml = vi.hoisted(() => [] as string[]);
vi.mock("../services/document/htmlToPdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/document/htmlToPdf")>();
  return { ...real, htmlToPdf: vi.fn(async (html: string) => { pdfHtml.push(html); return Buffer.from("%PDF-1.4 stand-in"); }) };
});

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s2a-aggregates-password-2026";
const h = g04Harness("s2a-agg");
const NO_PAY = ["viewer", "bookkeeper"] as const;
const PAY = ["accountant", "admin"] as const;

/** SOLO is the only Saudi, the only one in department "Solo", and the only one drawing an allowance. GONE is inactive. */
const SOLO = { employeeNumber: "AGG-SOLO", name: "Aggregate Solo", department: "Solo", nationality: "SA", gosiRegime: "law_1421h", gosiRegimeBasis: "certificate", nationalId: "1029384756", iban: "SA4420000001234567891234", basicSalary: 9137, housingAllowance: 2284, joiningDate: "2024-01-01" };
const OPS1 = { employeeNumber: "AGG-OPS1", name: "Aggregate Ops One", department: "Ops", nationality: "IN", nationalId: "2038475610", basicSalary: 7321, joiningDate: "2024-01-01" };
const OPS2 = { employeeNumber: "AGG-OPS2", name: "Aggregate Ops Two", department: "Ops", nationality: "IN", basicSalary: 6143, joiningDate: "2024-01-01" };
const GONE = { employeeNumber: "AGG-GONE", name: "Aggregate Gone", department: "Ops", nationality: "IN", basicSalary: 5419, joiningDate: "2024-01-01", status: "inactive" };
const gross = (e: { basicSalary: number; housingAllowance?: number }) => e.basicSalary + (e.housingAllowance ?? 0);
const TOTALS_WITHHELD = ["grossSalary", "gosiEmployer", "saudiCount", "gosiUnstatedCount"];

/** One person's figures as text, both ways a figure is written; a run's own totals are NOT secrets (D1). */
const secrets: string[] = [];
const money = (n: number) => (n > 0 ? [n.toFixed(2), n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })] : []);
const leaks = (text: string) => secrets.filter((s) => text.includes(s));
const withheldOf = (r: { headers: Record<string, string> }) => JSON.parse(r.headers["x-withheld"] ?? "[]") as { path: string; class: string; level: string }[];

describeDb("19B S2a — money aggregates over employees, with the twelve removed (owner item 2)", () => {
  let runId = 0;
  let entryId = 0;
  const ids: Record<string, number> = {};
  const account: Record<string, number> = {};

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S2a Aggregates Co", "319191919191923");
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) await h.mkUser(role, PW, orgId, role);
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) expect(await h.login(role, h.email(role), PW), role).toBe(200);
    for (const [k, e] of Object.entries({ SOLO, OPS1, OPS2, GONE })) {
      const r = await h.api("accountant", "POST", "/employees", e);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids[k] = r.body.id;
      secrets.push(...money(e.basicSalary), ...money(gross(e)));
    }
    secrets.push(...money(SOLO.housingAllowance), SOLO.nationalId, OPS1.nationalId, SOLO.iban, SOLO.iban.slice(0, -4));
    // 19B S3 (D2): SOLO's IBAN went through the hold (the accountant entered it); the admin approves it, so it is in place
    expect(await approveHeldIbans(h, "admin")).toBe(1);
    for (const code of ["SALARIES", "SALARIES_PAYABLE", "GOSI_PAYABLE", "GOSI_EXPENSE"]) {
      account[code] = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id;
    }
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  describe("GET /employees — totals over a set the caller chooses", () => {
    const list = (who: string, q: string) => h.api(who, "GET", `/employees${q}`);

    for (const [what, q] of [["a one-person search", "?search=Aggregate%20Solo"], ["a one-person department", "?department=Solo"]] as const) {
      it(`🔴 ${what}: an accountant and an admin are served that ONE person's pay — the leak — and the viewer and the bookkeeper are not`, async () => {
        for (const who of PAY) {
          const r = await list(who, q);
          expect([r.status, r.body.page.total, r.body.totals.grossSalary, r.body.totals.saudiCount], who).toEqual([200, 1, gross(SOLO), 1]);
          expect(r.body.totals.gosiEmployer, who).toBeGreaterThan(0);
        }
        for (const who of NO_PAY) {
          const r = await list(who, q);
          expect([r.status, r.body.page.total, r.body.items.map((e: { employeeNumber: string }) => e.employeeNumber)], who).toEqual([200, 1, ["AGG-SOLO"]]);
          expect(r.body.totals, who).toEqual({ payNotSetCount: 0 }); // the keys are ABSENT — never 0, never null
          expect(withheldOf(r).filter((w) => w.path.startsWith("totals.")).map((w) => `${w.path}:${w.class}`).sort(), who)
            .toEqual(["totals.gosiEmployer:compensation", "totals.gosiUnstatedCount:compensation", "totals.grossSalary:compensation", "totals.saudiCount:identity"]);
          expect(leaks(r.text), who).toEqual([]);
        }
      });
    }

    it("🔴 a subtraction of two totals (all employees minus all but one): the difference IS one person's pay for an accountant; neither total is served to the viewer or the bookkeeper", async () => {
      for (const who of PAY) {
        const all = await list(who, "");
        const active = await list(who, "?status=active");
        expect(all.body.totals.grossSalary - active.body.totals.grossSalary, who).toBe(gross(GONE));
      }
      for (const who of NO_PAY) {
        for (const q of ["", "?status=active", "?status=inactive", "?department=Ops"]) {
          const r = await list(who, q);
          expect(r.status, `${who} ${q}`).toBe(200);
          for (const k of TOTALS_WITHHELD) expect(k in r.body.totals, `${who} ${q} ${k}`).toBe(false);
          expect(leaks(r.text), `${who} ${q}`).toEqual([]);
        }
        // the counts stay: headcount, and pay not set
        const all = await list(who, "");
        expect([all.body.page.total, all.body.totals.payNotSetCount], who).toEqual([4, 0]);
      }
    });
  });

  describe("a payroll run — a fixed set (D1)", () => {
    beforeAll(async () => {
      const run = await h.api("accountant", "POST", "/payroll", { period: "2026-10" });
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      runId = run.body.id;
      const detail = await h.api("accountant", "GET", `/payroll/${runId}`);
      // A line's figure that EQUALS one of the run's own standard totals is D1's accepted case (here SOLO's employee GOSI is
      // the run's whole employee GOSI) — asserted on its own below, so it is not counted as a leak.
      const d1 = [detail.body.totalNetPay, detail.body.totalGosiEmployee, detail.body.totalGosiEmployer];
      for (const i of detail.body.items) for (const v of [i.netPay, i.gosiEmployee, i.gosiEmployer, i.gosiWageBase]) if (!d1.includes(v)) secrets.push(...money(v));
      expect((await h.api("accountant", "POST", `/payroll/${runId}/submit`, {})).status).toBe(200);
    });

    it("the approvals queue is an approver's worklist: the run is listed (net pay) for the accountant and the admin, never for the viewer or the bookkeeper", async () => {
      for (const who of PAY) {
        const q = await h.api(who, "GET", "/approvals/pending");
        expect(q.body.some((r: { entity: string; id: number }) => r.entity === "payroll" && r.id === runId), who).toBe(true);
      }
      for (const who of NO_PAY) {
        const q = await h.api(who, "GET", "/approvals/pending");
        expect(q.status, who).toBe(200);
        expect(q.body.some((r: { entity: string }) => r.entity === "payroll"), who).toBe(false);
      }
      const ok = await h.api("admin", "POST", `/payroll/${runId}/approve`, {});
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      entryId = (await pool.query(`SELECT id FROM journal_entries WHERE entry_number = $1`, [`PAY-2026-10-R${runId}`])).rows[0].id;
    });

    it("🔴 the run's basic/allowances SPLIT is withheld (not in the ledger; here the allowances are ONE person's); gross, net and both GOSI totals stay", async () => {
      const acc = await h.api("accountant", "GET", `/payroll/${runId}`);
      expect(acc.body.totalAllowances).toBe(SOLO.housingAllowance); // the single contributor: the leak the withholding stops
      expect(acc.body.totalBasicSalary).toBe(SOLO.basicSalary + OPS1.basicSalary + OPS2.basicSalary);
      for (const who of NO_PAY) {
        for (const path of [`/payroll/${runId}`, "/payroll"]) {
          const r = await h.api(who, "GET", path);
          const run = Array.isArray(r.body) ? r.body.find((x: { id: number }) => x.id === runId) : r.body;
          expect(r.status, `${who} ${path}`).toBe(200);
          expect(["totalBasicSalary" in run, "totalAllowances" in run], `${who} ${path}`).toEqual([false, false]);
          for (const k of ["totalNetPay", "totalGosiEmployee", "totalGosiEmployer"]) expect(typeof run[k], `${who} ${path} ${k}`).toBe("number");
          expect(withheldOf(r).map((w) => w.path).filter((p) => /totalBasicSalary|totalAllowances/.test(p)).length, `${who} ${path}`).toBe(2);
          expect(leaks(r.text), `${who} ${path}`).toEqual([]);
        }
        const list = await h.api(who, "GET", "/payroll");
        const row = list.body.find((x: { id: number }) => x.id === runId);
        expect([row.employeeCount, row.grossSalary], who).toEqual([3, gross(SOLO) + gross(OPS1) + gross(OPS2)]);
      }
    });

    it("🔴 a payslip line's GOSI rates (they state the GOSI law, and so the nationality) are withheld from the viewer and the bookkeeper", async () => {
      const acc = await h.api("accountant", "GET", `/payroll/${runId}`);
      const solo = acc.body.items.find((i: { employeeId: number }) => i.employeeId === ids.SOLO);
      const ops = acc.body.items.find((i: { employeeId: number }) => i.employeeId === ids.OPS1);
      expect([solo.gosiEmployeeRate > 0, ops.gosiEmployeeRate]).toEqual([true, 0]); // the rate tells the Saudi apart
      for (const who of NO_PAY) {
        const r = await h.api(who, "GET", `/payroll/${runId}`);
        for (const i of r.body.items) {
          expect(["gosiEmployeeRate" in i, "gosiEmployerRate" in i], who).toEqual([false, false]);
          expect(typeof i.employeeName, who).toBe("string");
        }
      }
    });

    it("🔴 the one-Saudi run: totalGosiEmployee IS that Saudi's GOSI — and a viewer derives it from the run's journal entry (GOSI payable − GOSI expense = gross − net), so it stays (D1)", async () => {
      const acc = await h.api("accountant", "GET", `/payroll/${runId}`);
      const solo = acc.body.items.find((i: { employeeId: number }) => i.employeeId === ids.SOLO);
      expect(acc.body.totalGosiEmployee).toBe(solo.gosiEmployee);
      expect(acc.body.totalGosiEmployee).toBeGreaterThan(0);
      for (const who of [...NO_PAY, ...PAY]) {
        const run = await h.api(who, "GET", `/payroll/${runId}`);
        expect(run.body.totalGosiEmployee, who).toBe(solo.gosiEmployee);
        const je = await h.api(who, "GET", `/journal-entries/${entryId}`);
        expect(je.status, who).toBe(200);
        const line = (code: string) => je.body.lines.find((l: { accountId: number }) => l.accountId === account[code]);
        const r2 = (n: number) => Math.round(n * 100) / 100;
        expect(r2(Number(line("GOSI_PAYABLE").creditAmount) - Number(line("GOSI_EXPENSE").debitAmount)), who).toBe(solo.gosiEmployee);
        expect(r2(Number(line("SALARIES").debitAmount) - Number(line("SALARIES_PAYABLE").creditAmount)), who).toBe(solo.gosiEmployee);
      }
    });

    it("the tax calendar's GOSI and the treasury forecast's payroll flows are the run's and the ledger's (fixed sets, D1): served to every role", async () => {
      const acc = await h.api("accountant", "GET", `/payroll/${runId}`);
      const gosiDue = Math.round((acc.body.totalGosiEmployee + acc.body.totalGosiEmployer) * 100) / 100;
      for (const who of [...NO_PAY, ...PAY]) {
        const ob = await h.api(who, "GET", "/tax/obligations");
        expect(ob.status, who).toBe(200);
        const row = (ob.body.obligations as { kind: string; amount: number; source?: { payrollRunId?: number } }[]).find((o) => o.kind === "gosi" && o.source?.payrollRunId === runId);
        expect(row?.amount, who).toBe(gosiDue);
        const fc = await h.api(who, "GET", "/treasury/forecast");
        expect(fc.status, who).toBe(200);
        const payroll: { amount: number }[] = [];
        const walk = (v: unknown): void => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if ((v as { category?: string }).category === "payroll") payroll.push(v as { amount: number }); Object.values(v).forEach(walk); } };
        walk(fc.body);
        expect(payroll.map((p) => p.amount), who).toContain(acc.body.totalNetPay);
        expect(leaks(ob.text + fc.text), who).toEqual([]);
      }
    });
  });

  describe("the report exports — CSV as served, PDF as built (stand-in named above)", () => {
    for (const who of NO_PAY) {
      it(`🔴 ${who}: no one person's pay, national ID or IBAN in any of the ${EXPORTABLE_REPORTS.length} report exports, CSV or PDF (there is no XLSX export)`, async () => {
        let csv = 0;
        let pdf = 0;
        for (const report of EXPORTABLE_REPORTS) {
          const c = await h.api(who, "GET", `/reports/export/${report}?format=csv&date_from=2026-01-01&date_to=2026-12-31`);
          if (c.status === 200) csv++;
          expect(leaks(c.text), `${who} ${report}.csv`).toEqual([]);
          const before = pdfHtml.length;
          const p = await h.api(who, "GET", `/reports/export/${report}?format=pdf&date_from=2026-01-01&date_to=2026-12-31`);
          if (p.status === 200) {
            pdf++;
            expect(pdfHtml.length, `${who} ${report}.pdf: built through the renderer`).toBe(before + 1);
            expect(leaks(pdfHtml.at(-1)!), `${who} ${report}.pdf`).toEqual([]);
          }
        }
        expect([csv >= 5, pdf >= 5], `${who}: the sweep reached real files (${csv} CSV, ${pdf} PDF)`).toEqual([true, true]);
      });
    }

    it("presence: the general ledger's export carries the run's own totals (D1) — so the sweep reads files that hold payroll", async () => {
      const acc = await h.api("accountant", "GET", `/payroll/${runId}`);
      for (const who of NO_PAY) {
        const c = await h.api(who, "GET", "/reports/export/general-ledger?format=csv&date_from=2026-01-01&date_to=2026-12-31");
        expect(c.status, who).toBe(200);
        expect(money(acc.body.totalNetPay).some((m) => c.text.includes(m)), `${who}: the run's net pay is in the general ledger`).toBe(true);
      }
    });
  });

  describe("GET routes WITH a path parameter that can return identity, pay or a bank account (owner item 4)", () => {
    /** Every node a response shape reaches. */
    const nodesOf = (shape: Shape): Set<string> => {
      const seen = new Set<string>();
      const walk = (s: Shape | undefined): void => {
        if (!s) return;
        if (s.k === "ref") { if (seen.has(`ref:${s.n}`)) return; seen.add(`ref:${s.n}`); walk(CONTRACT.components[s.n]); return; }
        if (s.k === "obj") { if (seen.has(s.n)) return; seen.add(s.n); Object.values(s.p).forEach(walk); walk(s.ap); return; }
        if (s.k === "arr") return walk(s.i);
        if (s.k === "map") return walk(s.v);
        if (s.k === "union") s.o.forEach(walk);
      };
      walk(shape);
      return new Set([...seen].filter((n) => !n.startsWith("ref:")));
    };
    const PROTECTED = ["identity", "compensation", "bank_account", "by_entity"] as const;
    const found = CONTRACT.operations
      .filter((o) => o.method.toUpperCase() === "GET" && o.path.includes("{"))
      .map((o) => {
        const resources = new Set<string>();
        for (const shape of Object.values(o.responses)) for (const n of nodesOf(shape)) {
          const row = FIELD_CLASS_TABLE[n];
          if (row && PROTECTED.some((c) => row[c])) resources.add(row.resource ?? "?");
        }
        return { path: o.path, resources: [...resources].sort() };
      })
      .filter((o) => o.resources.length > 0)
      .sort((a, b) => a.path.localeCompare(b.path));

    it("🔴 found from the class table: exactly four — S2a's two (employees, payroll), and customers' and vendors', which are S2b's and S2c's", () => {
      expect(CONTRACT.operations.filter((o) => o.method.toUpperCase() === "GET" && o.path.includes("{")).length).toBeGreaterThanOrEqual(57);
      expect(found).toEqual([
        { path: "/customers/{id}", resources: ["customers"] },
        { path: "/employees/{id}", resources: ["employees"] },
        { path: "/payroll/{id}", resources: ["payroll"] },
        { path: "/vendors/{id}", resources: ["vendors"] },
      ]);
    });

    it("🔴 S2a's two, as each role: no identity, pay or full IBAN for the viewer and the bookkeeper (named); every figure for the accountant and the admin", async () => {
      for (const path of [`/employees/${ids.SOLO}`, `/payroll/${runId}`]) {
        for (const who of NO_PAY) {
          const r = await h.api(who, "GET", path);
          expect(r.status, `${who} ${path}`).toBe(200);
          expect(leaks(r.text), `${who} ${path}`).toEqual([]);
          expect(withheldOf(r).length, `${who} ${path}: named`).toBeGreaterThan(0);
        }
        for (const who of PAY) {
          const r = await h.api(who, "GET", path);
          expect([r.status, r.headers["x-withheld"] ?? null], `${who} ${path}`).toEqual([200, null]);
          expect(leaks(r.text).length, `${who} ${path}: the figures are there`).toBeGreaterThan(0);
        }
      }
      const keeper = await h.api("bookkeeper", "GET", `/employees/${ids.SOLO}`);
      expect([keeper.body.iban, "nationalId" in keeper.body, "nationality" in keeper.body, "basicSalary" in keeper.body]).toEqual(["•••• 1234", false, false, false]);
      const viewer = await h.api("viewer", "GET", `/employees/${ids.SOLO}`);
      expect(["iban" in viewer.body, "bank" in viewer.body]).toEqual([false, false]);
    });
  });
});
