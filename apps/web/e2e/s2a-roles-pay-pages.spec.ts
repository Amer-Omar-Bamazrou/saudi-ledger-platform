import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 19B S2a — the Payroll and Employees pages with the twelve grants removed (owner item 4, 2026-11-23: "the Payroll
 * page for a bookkeeper and a viewer, in the browser"; and the Employees page as a viewer, which the pre-removal review
 * listed as missing). Arabic, 390 px.
 *
 *  - A BOOKKEEPER and a VIEWER: every payslip figure is marked withheld; the run's basic and allowances totals are marked
 *    withheld (owner item 2); the run's net and GOSI totals stay (D1). No one person's pay is anywhere in the page.
 *    Generate and Submit are offered and REFUSED with the explanation (D8 O2: an accountant or admin prepares payroll);
 *    nothing is created or submitted.
 *  - The VIEWER's Employees page: the Monthly Payroll, Monthly GOSI and Saudi cards are marked withheld, the headcount
 *    stays; no one person's pay, national ID or nationality is in the page.
 *  - Presence: the ACCOUNTANT's pages show the figures.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-s2a-roles-${STAMP}`;
const USERS = { accountant: `e2e-s2ar-acc-${STAMP}@smoke.local`, bookkeeper: `e2e-s2ar-keep-${STAMP}@smoke.local`, viewer: `e2e-s2ar-view-${STAMP}@smoke.local` } as const;
type Role = keyof typeof USERS;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const PERIOD = "2026-10";

/** SOLO is the only Saudi and the only one drawing an allowance; OPS is an expat. */
const SOLO = { employeeNumber: `S2AR-SOLO-${String(STAMP).slice(-5)}`, name: "Rania Solo", department: "Solo", nationality: "SA", gosiRegime: "law_1421h", gosiRegimeBasis: "certificate", nationalId: "1029384756", basicSalary: 9137, housingAllowance: 2284, joiningDate: "2024-01-01" };
const OPS = { employeeNumber: `S2AR-OPS-${String(STAMP).slice(-5)}`, name: "Omar Ops", department: "Ops", nationality: "IN", nationalId: "2038475610", basicSalary: 7321, joiningDate: "2024-01-01" };

let db: Db;
const api = {} as Record<Role, APIRequestContext>;
let orgId = "";
let runId = 0;
/** One person's figures, as the page would print them; a run's own totals (D1) are not among them. */
const secrets: string[] = [];
const shown = (n: number) => [n.toFixed(2), n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })];

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const emails = Object.values(USERS).map((e) => `'${e}'`).join(",");
  const users = `(SELECT id FROM users WHERE email IN (${emails}))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN (${emails})`);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S2a Roles Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S2a Roles Co',1,'gregorian')`, [orgId]);
  for (const role of Object.keys(USERS) as Role[]) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [USERS[role], `E2E S2a ${role}`, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    api[role] = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
    expect((await api[role].post("/api/auth/login", { data: { email: USERS[role], password: PASSWORD } })).ok(), `login ${role}`).toBeTruthy();
    expect((await api[role].post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
  for (const e of [SOLO, OPS]) {
    const r = await api.accountant.post("/api/employees", { data: e });
    expect(r.status(), await r.text()).toBe(201);
    secrets.push(...shown(e.basicSalary), ...shown(e.basicSalary + (e.housingAllowance ?? 0)), e.nationalId);
  }
  secrets.push(...shown(SOLO.housingAllowance));
  const run = await api.accountant.post("/api/payroll", { data: { period: PERIOD } });
  expect(run.status(), await run.text()).toBe(201);
  runId = (await run.json()).id;
  const detail = await (await api.accountant.get(`/api/payroll/${runId}`)).json();
  const d1 = [detail.totalNetPay, detail.totalGosiEmployee, detail.totalGosiEmployer];
  for (const i of detail.items) for (const v of [i.netPay, i.gosiEmployee, i.gosiEmployer]) if (v > 0 && !d1.includes(v)) secrets.push(...shown(v));
});

test.afterAll(async () => {
  for (const a of Object.values(api)) await a?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function pageAs(browser: Browser, role: Role, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api[role].storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}
const leaksIn = async (page: Page) => { const text = await page.content(); return secrets.filter((s) => text.includes(s)); };
const itemIds = async () => (await db.query(`SELECT id FROM payroll_items WHERE payroll_run_id = $1 ORDER BY id`, [runId])).rows.map((r) => r.id as number);
const runs = async () => (await db.query(`SELECT id, status FROM payroll_runs WHERE organization_id = $1 ORDER BY id`, [orgId])).rows as { id: number; status: string }[];

test.describe.serial("19B S2a — the pay pages, with the twelve removed (Arabic, 390 px)", () => {
  for (const role of ["bookkeeper", "viewer"] as const) {
    test(`🔴 ${role}: payslips and the run's basic/allowances totals are marked withheld; net and GOSI totals stay; no one person's pay in the page`, async ({ browser }) => {
      const { page, close } = await pageAs(browser, role, "/payroll");
      await expect(page.getByTestId(`payroll-withheld-totalBasicSalary-${runId}`).first()).toHaveText("محجوب (الرواتب)");
      await expect(page.getByTestId(`payroll-withheld-totalAllowances-${runId}`).first()).toHaveText("محجوب (الرواتب)");
      await page.getByTestId(`payroll-run-${runId}`).getByText(PERIOD, { exact: true }).click();
      for (const id of await itemIds()) {
        for (const f of ["basicSalary", "gosiEmployee", "gosiEmployer", "netPay"]) await expect(page.getByTestId(`payroll-withheld-${f}-${id}`), `${f} ${id}`).toHaveText("محجوب (الرواتب)");
      }
      await expect(page.getByText(SOLO.name).first()).toBeVisible(); // the person is named, the pay is not
      expect(await leaksIn(page), role).toEqual([]);
      await fitsAtPhoneWidth(page, `the payroll page (${role})`);
      await close();
    });

    test(`🔴 ${role}: Submit and Generate are offered and refused with the explanation (D8 O2); nothing is submitted or created`, async ({ browser }) => {
      const { page, close } = await pageAs(browser, role, "/payroll");
      const before = await runs();
      await page.getByTestId(`payroll-submit-${runId}`).click();
      await expect(page.getByText("يُعِدّ مسير الرواتب محاسبٌ أو مسؤول").first()).toBeVisible();
      await page.getByTestId("payroll-run-open").click();
      await page.getByTestId("payroll-generate-period").fill("2026-11");
      await page.getByTestId("payroll-generate").click();
      await expect(page.getByText("يُعِدّ مسير الرواتب محاسبٌ أو مسؤول").first()).toBeVisible();
      expect(await runs(), `${role}: nothing submitted, nothing created`).toEqual(before);
      expect(before).toEqual([{ id: runId, status: "draft" }]);
      await close();
    });
  }

  test("🔴 viewer: the Employees page marks Monthly Payroll, Monthly GOSI and the Saudi count withheld; the headcount stays; no one person's pay or ID in the page", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "viewer", "/employees");
    for (const f of ["grossSalary", "gosiEmployer"]) await expect(page.getByTestId(`employees-total-withheld-${f}`)).toHaveText("محجوب (الرواتب)");
    await expect(page.getByTestId("employees-total-withheld-saudiCount")).toHaveText("محجوب (الهوية)");
    await expect(page.getByTestId("employees-card-headcount")).toContainText("2");
    await expect(page.getByText(OPS.name).first()).toBeVisible();
    expect(await leaksIn(page)).toEqual([]);
    await fitsAtPhoneWidth(page, "the employees page (viewer)");
    await close();
  });

  test("presence: the accountant's pages show the figures the others are refused", async ({ browser }) => {
    const pay = await pageAs(browser, "accountant", "/payroll");
    await expect(pay.page.getByTestId(`payroll-withheld-totalBasicSalary-${runId}`)).toHaveCount(0);
    expect((await leaksIn(pay.page)).length).toBeGreaterThan(0);
    await pay.close();
    const emp = await pageAs(browser, "accountant", "/employees");
    await expect(emp.page.getByTestId("employees-card-payroll")).toContainText(shown(SOLO.basicSalary + SOLO.housingAllowance + OPS.basicSalary)[1]!);
    await expect(emp.page.getByTestId("employees-total-withheld-grossSalary")).toHaveCount(0);
    await emp.close();
  });
});
