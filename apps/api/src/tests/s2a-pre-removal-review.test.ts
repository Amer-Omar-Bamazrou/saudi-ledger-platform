/**
 * 🔴 19B S2a — THE PRE-REMOVAL REVIEW, RUN WITH THE TWELVE GRANTS REMOVED (owner, 2026-11-22: "each is shown by a test
 * run with the grants actually removed").
 *
 * 🔴 Restated for the removal (2026-11-23): the twelve are out of PERMISSION_MATRIX itself (S2A_REMOVALS), so this
 * process's grant cache — the set the response seam and the write check read for every request — lacks them as every
 * fresh database reconciled to the matrix does. An existing database's table loses them only with the owner's approval
 * string for it.
 *
 *  B. A bookkeeper still lists, opens, searches (the only employee picker: the list's search) and references employees
 *     by name, number, job and department, and creates one — without pay.
 *  C. For the viewer and the bookkeeper, the full IBAN, the identity fields and every pay figure appear on NO path:
 *     the employee list, detail and search; the payroll list, detail and payslips; every one of the twelve report
 *     exports; the audit trail; and every other GET the contract has (a sweep). Three employees with distinct pay, so
 *     a run's totals never equal one person's pay.
 *  D. A write to a field the role may not write is refused on the server, by name; the database is unchanged; the
 *     value is never echoed back. A write it may make (the national ID, the IBAN) succeeds and is not echoed either.
 *     The only code that writes an employee's or a payroll line's fields is the guarded service (a census).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, PERMISSION_MATRIX, S2A_REMOVALS } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { CONTRACT } from "../lib/fieldClasses/contractShapes.generated";
import { EXPORTABLE_REPORTS } from "../services/reporting/reportExport.service";
import { g04Harness } from "./helpers/g04Harness";
import { approveHeldIbans } from "./helpers/approveHeldIbans";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s2a-review-password-2026";
const h = g04Harness("s2a-rev");
const key = (r: { role: string; resource: string; action: string }) => `${r.role}:${r.resource}:${r.action}`;
const REMOVED = new Set(S2A_REMOVALS.map(key));
const S2A_MATRIX = PERMISSION_MATRIX.filter((r) => !REMOVED.has(key(r)));

/**
 * Three employees, distinct pay; every value below is searched for, as text, in every response a role is served. TWO
 * are Saudi, so no GOSI total is one person's contribution: a run's totals are standard (v4 §5.2), and a total over a
 * single contributor IS that person's figure — D1's accepted one-employee limit, which the pre-removal review names.
 */
const STAFF = [
  { employeeNumber: "REV-1", name: "Reviewed One", jobTitle: "Clerk", department: "Finance", nationality: "SA", nationalId: "1098765432", gosiNumber: "GOSI-55501", iban: "SA4420000001234567891234", bank: "Rajhi", basicSalary: 9137.43, housingAllowance: 2284.36, transportAllowance: 913.74, notes: "pay-note-secret-ONE", gosiRegime: "law_2024", gosiRegimeBasis: "certificate", joiningDate: "2025-01-01" },
  { employeeNumber: "REV-2", name: "Reviewed Two", jobTitle: "Driver", department: "Ops", nationality: "EX", nationalId: "2087654321", gosiNumber: "GOSI-55502", iban: "SA5510000009876543210987", bank: "SNB", basicSalary: 7251.19, housingAllowance: 1813.27, transportAllowance: 725.12, notes: "pay-note-secret-TWO", joiningDate: "2025-02-01" },
  { employeeNumber: "REV-3", name: "Reviewed Three", jobTitle: "Cook", department: "Kitchen", nationality: "SA", gosiRegime: "law_1421h", gosiRegimeBasis: "certificate", nationalId: "1076543210", gosiNumber: "GOSI-55503", iban: "SA6610000005555666677778", bank: "SNB", basicSalary: 6413.77, housingAllowance: 1603.44, transportAllowance: 641.38, notes: "pay-note-secret-THREE", joiningDate: "2025-03-01" },
];
const secrets: string[] = [];
/** A pay figure as text, both ways it is written. A zero is no one's secret (an expat's employee GOSI is 0.00). */
const money = (n: number) => (n > 0 ? [n.toFixed(2), n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })] : []);

/** A GET as a role, as SERVED: the raw text (searched for every secret) and the X-Withheld header. */
async function raw(who: string, path: string): Promise<{ status: number; text: string; withheld: string | null }> {
  const r = await h.api(who, "GET", path);
  return { status: r.status, text: r.text, withheld: r.headers["x-withheld"] ?? null };
}

describeDb("19B S2a pre-removal review — with the twelve grants removed", () => {
  let runId = 0;
  const ids: number[] = [];

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S2a Review Co", "319191919191983");
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) await h.mkUser(role, PW, orgId, role);
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) expect(await h.login(role, h.email(role), PW), role).toBe(200);
    for (const s of STAFF) {
      const r = await h.api("accountant", "POST", "/employees", s);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids.push(r.body.id);
      secrets.push(s.nationalId, s.gosiNumber, s.iban, s.iban.slice(0, -4), s.notes, ...money(s.basicSalary), ...money(s.housingAllowance), ...money(s.basicSalary + s.housingAllowance + s.transportAllowance));
    }
    // 19B S3 (D2): each IBAN went through the hold (the accountant entered them); the admin approves them, so they are in place
    expect(await approveHeldIbans(h, "admin")).toBe(STAFF.length);
    const run = await h.api("accountant", "POST", "/payroll", { period: "2026-10" });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    runId = run.body.id;
    const detail = await h.api("accountant", "GET", `/payroll/${runId}`);
    for (const i of detail.body.items) secrets.push(...money(i.netPay), ...money(i.grossSalary), ...money(i.gosiEmployee));
    expect((await h.api("admin", "POST", `/payroll/${runId}/approve`, {})).status).toBe(200); // the ledger now carries the run
    // A run's TOTALS are standard (v4 §5.2); with three distinct people none of them equals one person's pay.
    expect(STAFF.map((s) => s.basicSalary)).not.toContain(detail.body.totalBasicSalary);
    primePermissionCache(S2A_MATRIX);
  });
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  const leaks = (text: string) => secrets.filter((s) => text.includes(s));

  // Restated for the removal (2026-11-23): S1's matrix held 395 grants and this test removed the twelve from the cache;
  // the matrix itself now lacks exactly them.
  it("the twelve are out of what this process enforces — PERMISSION_MATRIX itself — and nothing else is", () => {
    expect(PERMISSION_MATRIX.filter((r) => REMOVED.has(key(r))).map(key)).toEqual([]);
    expect(REMOVED.size).toBe(12);
    // 19B S3 added the six `bank_detail` grants (read ×4, approve ×2) — additions, outside S2a's set
    // 19B S4 added the 22 report-dataset grants (journal_lines: v4 §6.2) — additions, outside S2a's set too
    const later = (r: { resource: string }) => r.resource === "bank_detail" || r.resource.startsWith("report_dataset.");
    const withoutLater = PERMISSION_MATRIX.filter((r) => !later(r));
    // 19B S2b removed its seven (S2B_REMOVALS) — outside S2a's set too, and none of the twelve (field-class-grants pins both)
    expect([withoutLater.length, S2A_MATRIX.filter((r) => !later(r)).length, PERMISSION_MATRIX.filter((r) => r.resource === "bank_detail").length, PERMISSION_MATRIX.filter((r) => r.resource.startsWith("report_dataset.")).length]).toEqual([395 - 12 - 7, 395 - 12 - 7, 6, 22]);
  });

  // ── B ──
  it("🔴 B. a bookkeeper lists, opens, searches and references employees (name, number, job, department), and creates one without pay", async () => {
    const list = await h.api("bookkeeper", "GET", "/employees?status=active");
    expect(list.status).toBe(200);
    expect(list.body.items.map((e: { employeeNumber: string }) => e.employeeNumber).sort()).toEqual(["REV-1", "REV-2", "REV-3"]);
    for (const e of list.body.items) expect([typeof e.name, typeof e.employeeNumber, typeof e.jobTitle, typeof e.department]).toEqual(["string", "string", "string", "string"]);
    const one = await h.api("bookkeeper", "GET", `/employees/${ids[0]}`);
    expect([one.status, one.body.name, one.body.employeeNumber, one.body.jobTitle, one.body.department]).toEqual([200, "Reviewed One", "REV-1", "Clerk", "Finance"]);
    const search = await h.api("bookkeeper", "GET", "/employees?search=Two");
    expect(search.body.items.map((e: { employeeNumber: string }) => e.employeeNumber)).toEqual(["REV-2"]);
    const run = await h.api("bookkeeper", "GET", `/payroll/${runId}`);
    expect(run.body.items.map((i: { employeeName: string }) => i.employeeName).sort()).toEqual(["Reviewed One", "Reviewed Three", "Reviewed Two"]);
    const created = await h.api("bookkeeper", "POST", "/employees", { employeeNumber: "REV-NEW", name: "New Hire", jobTitle: "Clerk", department: "Finance", nationalId: "1011111111", iban: "SA0380000000608010167519" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.payNotSet).toBe(true);
    expect("nationalId" in created.body).toBe(false); // written, never read back
    // 🔴 Restated for 19B S3 (D2, v4 §6.3): the IBAN a bookkeeper enters is HELD for an accountant or admin — the employee
    // is created without it, and the held change shows it as its last four (the employees grants, per row).
    expect([created.body.iban, created.body.ibanPending]).toEqual([null, true]);
    expect(created.body.pendingBankDetailChanges[0].ibanAfter).toBe("•••• 7519");
    const row = (await pool.query(`SELECT national_id, iban, basic_salary FROM employees WHERE id = $1`, [created.body.id])).rows[0];
    expect(row).toEqual({ national_id: "1011111111", iban: null, basic_salary: null });
  });

  it("🔴 B. field access tells each role what it may read and write — the page offers only that (never a value)", async () => {
    const of = async (role: string) => (await h.api(role, "GET", "/employees/field-access")).body.fields as Record<string, { class: string; read: string; write: boolean }>;
    const keeper = await of("bookkeeper");
    expect(keeper.nationalId).toEqual({ class: "identity", read: "none", write: true });
    expect(keeper.iban).toEqual({ class: "bank_account", read: "last4", write: true });
    expect(keeper.basicSalary).toEqual({ class: "compensation", read: "none", write: false });
    expect(keeper.status).toEqual({ class: "standard", read: "read", write: false }); // D1: its write needs compensation
    expect(keeper.nationality).toEqual({ class: "identity", read: "none", write: false });
    expect([keeper.name.write, keeper.jobTitle.write, keeper.department.write, keeper.payNotSet.read]).toEqual([true, true, true, "read"]);
    const viewer = await of("viewer");
    expect(Object.entries(viewer).filter(([, f]) => f.write).map(([k]) => k), "a viewer writes nothing").toEqual([]);
    expect([viewer.iban.read, viewer.nationalId.read, viewer.basicSalary.read, viewer.name.read]).toEqual(["none", "none", "none", "read"]);
    const acc = await of("accountant");
    expect(Object.entries(acc).filter(([, f]) => f.read !== "read").map(([k]) => k), "an accountant reads everything").toEqual([]);
    expect([acc.basicSalary.write, acc.status.write, acc.endDate.write, acc.nationality.write]).toEqual([true, true, true, true]);
    const pay = (await h.api("bookkeeper", "GET", "/payroll/field-access")).body.fields as Record<string, { read: string; write: boolean }>;
    expect([pay.netPay.read, pay.employeeName.read, pay.netPay.write]).toEqual(["none", "read", false]);
  });

  // ── C ──
  for (const role of ["viewer", "bookkeeper"] as const) {
    it(`🔴 C. ${role}: no identity, pay or full IBAN on the employee list, detail and search — absent, named in X-Withheld`, async () => {
      for (const path of ["/employees?status=active", `/employees/${ids[0]}`, "/employees?search=Reviewed"]) {
        const r = await raw(role, path);
        expect(r.status, path).toBe(200);
        expect(leaks(r.text), `${role} ${path}`).toEqual([]);
        expect(r.withheld, path).toBeTruthy();
      }
      const one = await h.api(role, "GET", `/employees/${ids[0]}`);
      for (const k of ["nationalId", "gosiNumber", "nationality", "basicSalary", "housingAllowance", "grossSalary", "gosiEmployee", "gosiEmployer", "gosiRegime", "notes"]) expect(k in one.body, `${role} ${k}`).toBe(false);
      if (role === "viewer") expect("iban" in one.body).toBe(false);
      else expect(one.body.iban).toBe("•••• 1234");
      expect(one.body.payNotSet).toBe(false); // standard: shown to every role
    });

    it(`🔴 C. ${role}: no pay on the payroll list, the run's detail or its payslips`, async () => {
      for (const path of ["/payroll", `/payroll/${runId}`]) {
        const r = await raw(role, path);
        expect(r.status, path).toBe(200);
        expect(leaks(r.text), `${role} ${path}`).toEqual([]);
      }
      const run = await h.api(role, "GET", `/payroll/${runId}`);
      for (const i of run.body.items) for (const k of ["basicSalary", "grossSalary", "gosiEmployee", "gosiEmployer", "netPay", "additions", "deductions", "gosiWageBase"]) expect(k in i, `${role} ${k}`).toBe(false);
      expect(typeof run.body.totalNetPay).toBe("number"); // the run's totals stay standard (v4 §5.2)
    });

    it(`🔴 C. ${role}: no identity, pay or full IBAN in any of the ${EXPORTABLE_REPORTS.length} report exports`, async () => {
      let served = 0;
      for (const report of EXPORTABLE_REPORTS) {
        const r = await raw(role, `/reports/export/${report}?format=csv&date_from=2026-01-01&date_to=2026-12-31`);
        if (r.status === 200) served++;
        expect(leaks(r.text), `${role} ${report}`).toEqual([]);
      }
      expect(served, "the sweep reached real files").toBeGreaterThanOrEqual(5);
      expect((await raw(role, "/reports/export/general-ledger?format=csv&date_from=2026-01-01&date_to=2026-12-31")).status).toBe(200);
    });

    it(`🔴 C. ${role}: the audit trail is closed to the role (admin only)`, async () => {
      expect((await raw(role, "/audit-logs")).status).toBe(403);
    });

    it(`🔴 C. ${role}: no identity, pay or full IBAN on ANY other GET the contract has (a sweep)`, async () => {
      const gets = CONTRACT.operations.filter((o) => o.method === "GET" && !o.path.includes("{") && Object.keys(o.responses).length > 0);
      let ok = 0;
      const leaked: string[] = [];
      for (const op of gets) {
        const r = await raw(role, op.path);
        if (r.status === 200) ok++;
        for (const s of leaks(r.text)) leaked.push(`${op.path}: ${s}`);
      }
      expect(leaked).toEqual([]);
      expect(ok, "the sweep reached real answers").toBeGreaterThan(50);
    });
  }

  // ── D ──
  it("🔴 D. a bookkeeper's write to a field it may not write: refused by name, the database unchanged, the value never echoed", async () => {
    const before = (await pool.query(`SELECT basic_salary, status, end_date, nationality, gosi_number, notes, gosi_regime FROM employees WHERE id = $1`, [ids[0]])).rows[0];
    const attempts: Record<string, unknown>[] = [
      { basicSalary: 4242.42 }, { housingAllowance: 4242.42 }, { status: "terminated" }, { endDate: "2026-12-31" }, { joiningDate: "2024-06-01" },
      { nationality: "EX" }, { gosiNumber: "GOSI-4242" }, { notes: "note-4242" }, { gosiRegime: "law_1421h" }, { name: "Renamed", basicSalary: 4242.42 },
    ];
    for (const body of attempts) {
      const r = await h.api("bookkeeper", "PATCH", `/employees/${ids[0]}`, body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(r.body.code).toBe("field_write_not_granted");
      expect(r.body.errorAr).toBeTruthy();
      const text = JSON.stringify(r.body);
      for (const v of Object.values(body)) if (typeof v !== "string" || v !== "Renamed") expect(text.includes(String(v)), `echo of ${v}`).toBe(false);
    }
    const after = (await pool.query(`SELECT basic_salary, status, end_date, nationality, gosi_number, notes, gosi_regime, name FROM employees WHERE id = $1`, [ids[0]])).rows[0];
    expect({ ...after, name: undefined }).toEqual({ ...before, name: undefined });
    expect(after.name).toBe("Reviewed One"); // the mixed body saved NOTHING, its allowed half included
    const createPaid = await h.api("bookkeeper", "POST", "/employees", { employeeNumber: "REV-PAID", name: "Paid By Keeper", basicSalary: 5000 });
    expect([createPaid.status, createPaid.body.code]).toEqual([403, "field_write_not_granted"]);
    expect((await pool.query(`SELECT count(*)::int n FROM employees WHERE employee_number = 'REV-PAID'`)).rows[0].n).toBe(0);
  });

  // 🔴 Restated for 19B S3 (D2, v4 §6.3): the IBAN half is HELD — the current one stays (shown as its last four) until an
  // accountant or admin who did not enter it approves; then the new one is in place, still never echoed in full.
  it("🔴 D. what a bookkeeper MAY write: the national ID is saved and not echoed back; the IBAN is held, then approved, never echoed in full", async () => {
    const id = await h.api("bookkeeper", "PATCH", `/employees/${ids[1]}`, { nationalId: "2099999999" });
    expect(id.status, JSON.stringify(id.body)).toBe(200);
    expect("nationalId" in id.body).toBe(false);
    expect(JSON.stringify(id.body).includes("2099999999")).toBe(false);
    const current = STAFF[1]!.iban;
    const iban = await h.api("bookkeeper", "PATCH", `/employees/${ids[1]}`, { iban: "SA7710000001111222233334" });
    expect([iban.status, iban.body.iban, iban.body.ibanPending], JSON.stringify(iban.body)).toEqual([200, `•••• ${current.slice(-4)}`, true]);
    expect(iban.body.pendingBankDetailChanges[0].ibanAfter).toBe("•••• 3334");
    expect(JSON.stringify(iban.body).includes("SA7710000001111222233334")).toBe(false);
    expect((await pool.query(`SELECT national_id, iban FROM employees WHERE id = $1`, [ids[1]])).rows[0]).toEqual({ national_id: "2099999999", iban: current });
    const ok = await h.api("accountant", "PUT", `/companies/current/bank-detail-changes/${iban.body.pendingBankDetailChanges[0].id}/decision`, { decision: "approve" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const row = (await pool.query(`SELECT national_id, iban FROM employees WHERE id = $1`, [ids[1]])).rows[0];
    expect(row).toEqual({ national_id: "2099999999", iban: "SA7710000001111222233334" });
    expect((await h.api("bookkeeper", "GET", `/employees/${ids[1]}`)).body.iban).toBe("•••• 3334");
  });

  it("🔴 D. a viewer writes nothing (the route's own grant refuses it first), and a bookkeeper no longer prepares a run", async () => {
    const v = await h.api("viewer", "PATCH", `/employees/${ids[2]}`, { name: "Viewer Was Here" });
    expect(v.status).toBe(403);
    expect((await pool.query(`SELECT name FROM employees WHERE id = $1`, [ids[2]])).rows[0].name).toBe("Reviewed Three");
    const runs = async () => (await pool.query(`SELECT count(*)::int n FROM payroll_runs r JOIN organizations o ON o.id = r.organization_id WHERE o.slug = 's2a-rev-org'`)).rows[0].n;
    const before = await runs();
    const k = await h.api("bookkeeper", "POST", "/payroll", { period: "2026-11" });
    expect([k.status, k.body.code]).toEqual([403, "requires_approval_authority"]);
    expect(await runs()).toBe(before);
  });

  it("🔴 D. no route writes an employee's or a payroll line's fields except through the guarded services (a census)", () => {
    const src = fileURLToPath(new URL("../", import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== "tests" && f !== "generated") walk(p); } else if (p.endsWith(".ts")) files.push(p); } };
    walk(src);
    const writers = files.filter((f) => /\.(insert|update)\((employeesTable|payrollItemsTable)\)|(INSERT INTO|UPDATE)\s+"?(employees|payroll_items)"?\s/i.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(src.length).replace(/\\/g, "/")).sort();
    // employees: the repository the service calls (POST/PATCH /employees, behind requirePermission and the field write
    // check); payroll lines: the repository the payroll service calls at generation (POST /payroll, `payroll:create`).
    expect(writers).toEqual(["repositories/employees.repository.ts", "repositories/payroll.repository.ts"]);
    const callers = files.filter((f) => /employeesRepository\.(insert|update)\(/.test(readFileSync(f, "utf8"))).map((f) => f.slice(src.length).replace(/\\/g, "/"));
    expect(callers).toEqual(["services/employees.service.ts"]);
    const itemCallers = files.filter((f) => /payrollRepository\.insertItems\(/.test(readFileSync(f, "utf8"))).map((f) => f.slice(src.length).replace(/\\/g, "/"));
    expect(itemCallers).toEqual(["services/payroll.service.ts"]);
  });
});
