import { test, expect, request as pwRequest, type APIRequestContext } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 Owner item 3 (2026-11-23): "an employee whose end date falls inside the period is named in the run and not paid
 * automatically, until the accountant answers how a final part-month is paid".
 *
 * Through the Payroll page, in Arabic at 390 px, the requests the page itself builds:
 *  1. With only a leaver, Generate is refused: "this run would pay nobody", naming the leaver and why — nothing created.
 *  2. With a paid colleague added, the run is created: the toast names the leaver and why, the run's detail lists them
 *     with the reason, and only the colleague has a payslip.
 * 🔴 Its OWN tenant, created and removed here. The period is fixed (2026-11), never "today".
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-lvr-${STAMP}`;
const ACCOUNTANT = `e2e-lvr-acc-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const PERIOD = "2026-11";
const LEAVER = `LVR-${String(STAMP).slice(-6)}`;
const STAYER = `STY-${String(STAMP).slice(-6)}`;

let db: Db;
let accApi: APIRequestContext;
let orgId = "";

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email = '${ACCOUNTANT}')`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email = $1`, [ACCOUNTANT]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Leavers Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Leavers Co',1,'gregorian')`, [orgId]);
  const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E Leavers Accountant',$2,'viewer',true) RETURNING id`, [ACCOUNTANT, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'accountant','active')`, [orgId, id]);
  accApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await accApi.post("/api/auth/login", { data: { email: ACCOUNTANT, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await accApi.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
  // The leaver: still active, leaving on the 15th of the period.
  const r = await accApi.post("/api/employees", { data: { employeeNumber: LEAVER, name: "Salem Leaver", nationality: "IN", basicSalary: 7100, joiningDate: "2024-01-01", endDate: `${PERIOD}-15`, status: "active" } });
  expect(r.status(), await r.text()).toBe(201);
});

test.afterAll(async () => {
  await accApi?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function payrollPage(browser: import("@playwright/test").Browser) {
  const ctx = await browser.newContext({ storageState: await accApi.storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto("/payroll", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const sent: Record<string, unknown>[] = [];
  page.on("request", (q) => { if (new URL(q.url()).pathname === "/api/payroll" && q.method() === "POST") sent.push(JSON.parse(q.postData() ?? "{}")); });
  return { ctx, page, sent };
}
async function generate(page: import("@playwright/test").Page) {
  await page.getByTestId("payroll-run-open").click();
  await page.getByTestId("payroll-generate-period").fill(PERIOD);
  await fitsAtPhoneWidth(page, "the generate dialog");
  await page.getByTestId("payroll-generate").click();
}
const runs = async () => (await db.query(`SELECT id FROM payroll_runs WHERE organization_id = $1 AND period = $2`, [orgId, PERIOD])).rows as { id: number }[];

test.describe.serial("Owner item 3 — a leaver in the payroll run, through the browser", () => {
  test("🔴 with only a leaver, Generate is refused in Arabic, naming the leaver and why; nothing is created", async ({ browser }) => {
    const { ctx, page, sent } = await payrollPage(browser);
    await generate(page);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ period: PERIOD });
    const toast = page.getByText("لن يُصرف في هذا المسير لأحد").first();
    await expect(toast).toBeVisible();
    await expect(page.getByText(/Salem Leaver \(تنتهي خدمته هذا الشهر/).first()).toBeVisible();
    expect(await runs()).toEqual([]);
    await ctx.close();
  });

  test("🔴 with a paid colleague, the run is created: the leaver is named with the reason, and only the colleague is paid", async ({ browser }) => {
    const r = await accApi.post("/api/employees", { data: { employeeNumber: STAYER, name: "Nora Stayer", nationality: "IN", basicSalary: 6300, joiningDate: "2024-01-01" } });
    expect(r.status(), await r.text()).toBe(201);
    const stayerId = (await r.json()).id as number;
    const leaverId = (await db.query(`SELECT id FROM employees WHERE organization_id = $1 AND employee_number = $2`, [orgId, LEAVER])).rows[0].id as number;
    const { ctx, page } = await payrollPage(browser);
    await generate(page);
    await expect(page.getByText("تم إنشاء مسير الرواتب").first()).toBeVisible();
    await expect(page.getByText(/Salem Leaver \(تنتهي خدمته هذا الشهر/).first()).toBeVisible();
    await expect.poll(async () => (await runs()).length).toBe(1);
    const [{ id: runId }] = await runs();
    await expect(page.getByTestId(`payroll-left-out-count-${runId}`)).toHaveText("1 مستبعد");
    // the period label, not the row's centre (a draft row's centre is its Submit button)
    await page.getByTestId(`payroll-run-${runId}`).getByText(PERIOD, { exact: true }).click();
    const named = page.getByTestId(`payroll-left-out-${leaverId}`);
    await expect(named).toContainText("Salem Leaver");
    await expect(named).toContainText(LEAVER);
    await expect(named).toContainText("تنتهي خدمته هذا الشهر — لا يُصرف الجزء الأخير من الشهر تلقائيًا");
    await fitsAtPhoneWidth(page, "the run's left-out list");
    const paid = (await db.query(`SELECT employee_id FROM payroll_items WHERE payroll_run_id = $1`, [runId])).rows.map((x) => x.employee_id);
    expect(paid).toEqual([stayerId]);
    await ctx.close();
  });
});
