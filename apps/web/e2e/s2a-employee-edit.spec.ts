import { test, expect, request as pwRequest, type APIRequestContext, type Browser } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 19B S2a (owner, 2026-11-22, item 1): "O2 needs an edit path … Add an edit form for accountants and admins covering
 * pay, status, nationality, the dates, and an end date. Bookkeepers edit only the fields O2 leaves them. A client-path
 * browser test for both roles, in Arabic at 390 px."
 *
 * The CLIENT PATH: every request below is the one the page builds, captured as it leaves the browser.
 *  1. A bookkeeper creates an employee WITHOUT pay through the form: the request carries no pay, the list shows
 *     "الراتب غير محدد" (pay not set).
 *  2. A bookkeeper edits that employee: the form offers EXACTLY the fields the server says the role may write
 *     (GET /employees/field-access) — under S1 every field; once S2a's grants are removed, only name, number, job,
 *     department, the national ID (written, never shown) and the IBAN — and the save sends ONLY what changed.
 *  3. An accountant edits the same employee's pay, status and end date: the request carries them, the database holds
 *     them, and the list shows the departure.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };
type Access = { fields: Record<string, { class: string; read: string; write: boolean }> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-s2a-${STAMP}`;
const ACCOUNTANT = `e2e-s2a-acc-${STAMP}@smoke.local`;
const KEEPER = `e2e-s2a-keeper-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const NUMBER = `S2A-${String(STAMP).slice(-6)}`;

let db: Db;
let accApi: APIRequestContext;
let keeperApi: APIRequestContext;
let orgId = "";

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email IN ('${ACCOUNTANT}','${KEEPER}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2)`, [ACCOUNTANT, KEEPER]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S2a Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S2a Co',1,'gregorian')`, [orgId]);
  for (const [email, name, role] of [[ACCOUNTANT, "E2E S2a Accountant", "accountant"], [KEEPER, "E2E S2a Keeper", "bookkeeper"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
  }
  accApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  keeperApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  for (const [api, email] of [[accApi, ACCOUNTANT], [keeperApi, KEEPER]] as const) {
    expect((await api.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
    expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await accApi?.dispose();
  await keeperApi?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

/** A phone-width Arabic Employees page signed in through `api`, capturing every employee write it sends. */
async function employeesPage(browser: Browser, api: APIRequestContext) {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto("/employees", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (/^\/api\/employees(\/\d+)?$/.test(path) && (r.method() === "POST" || r.method() === "PATCH")) sent.push({ method: r.method(), path, body: JSON.parse(r.postData() ?? "{}") });
  });
  return { ctx, page, sent };
}
const row = async () => (await db.query(`SELECT id, name, job_title, basic_salary, status, end_date, national_id, iban FROM employees WHERE organization_id = $1 AND employee_number = $2`, [orgId, NUMBER])).rows[0];
/** The form's own fields, by the data-testid each one carries. */
const FORM_FIELDS = ["employeeNumber", "name", "nameAr", "nationalId", "jobTitle", "jobTitleAr", "department", "gosiNumber", "iban", "bank", "joiningDate", "endDate", "basicSalary", "housingAllowance", "transportAllowance", "otherAllowances", "nationality", "status", "notes"];

test.describe.serial("19B S2a — the employee form, by role, through the browser", () => {
  test("🔴 a bookkeeper creates an employee WITHOUT pay: no pay leaves the page, and the list says 'pay not set'", async ({ browser }) => {
    const { ctx, page, sent } = await employeesPage(browser, keeperApi);
    await page.getByTestId("employee-add").click();
    const form = page.getByTestId("employee-form");
    await expect(form).toBeVisible();
    await form.getByTestId("employee-form-employeeNumber").fill(NUMBER);
    await form.getByTestId("employee-form-name").fill("Hala Keeper-Made");
    await form.getByTestId("employee-form-jobTitle").fill("Clerk");
    await form.getByTestId("employee-form-department").fill("Finance");
    await form.getByTestId("employee-form-nationalId").fill("1012345678");
    await form.getByTestId("employee-form-iban").fill("SA0380000000608010167519");
    await fitsAtPhoneWidth(page, "the employee form");
    await form.getByTestId("employee-form-save").click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.method).toBe("POST");
    for (const k of ["basicSalary", "housingAllowance", "transportAllowance", "otherAllowances"]) expect(k in sent[0]!.body, `no ${k} leaves the page`).toBe(false);
    await expect.poll(async () => (await row())?.basic_salary ?? "missing").toBeNull();
    const id = (await row()).id;
    await expect(page.getByTestId(`employee-pay-not-set-${id}`).first()).toHaveText("الراتب غير محدد");
    await ctx.close();
  });

  test("🔴 a bookkeeper's edit form offers EXACTLY the fields the server lets the role write, and sends only what changed", async ({ browser }) => {
    const access = (await (await keeperApi.get("/api/employees/field-access")).json()) as Access;
    const { ctx, page, sent } = await employeesPage(browser, keeperApi);
    const { id } = await row();
    await page.getByTestId(`employee-edit-${id}`).click();
    const form = page.getByTestId("employee-form");
    await expect(form).toBeVisible();
    for (const f of FORM_FIELDS) {
      await expect(form.getByTestId(`employee-form-${f}`), `${f}: offered only if the role may write it`).toHaveCount(access.fields[f]?.write ? 1 : 0);
    }
    if (!access.fields.basicSalary?.write) {
      // S2a's grants removed: no pay, status or dates to change; the national ID is written, never shown back.
      await expect(form.getByTestId("employee-form-readonly")).toBeVisible();
      await expect(form.getByTestId("employee-form-nationalId")).toHaveValue("");
    }
    await form.getByTestId("employee-form-jobTitle").fill("Senior Clerk");
    await form.getByTestId("employee-form-save").click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ method: "PATCH", path: `/api/employees/${id}`, body: { jobTitle: "Senior Clerk" } });
    await expect.poll(async () => (await row()).job_title).toBe("Senior Clerk");
    expect((await row()).national_id, "a withheld value is never sent back blank").toBe("1012345678");
    await ctx.close();
  });

  test("🔴 an accountant sets the pay, the status and the end date; the list shows the departure", async ({ browser }) => {
    const { ctx, page, sent } = await employeesPage(browser, accApi);
    const { id } = await row();
    await page.getByTestId(`employee-edit-${id}`).click();
    const form = page.getByTestId("employee-form");
    await expect(form).toBeVisible();
    await expect(form.getByTestId("employee-form-endDate"), "the end date has a field").toBeVisible();
    await form.getByTestId("employee-form-basicSalary").fill("7000");
    await form.getByTestId("employee-form-endDate").fill("2026-12-31");
    await form.getByTestId("employee-form-status").click();
    await page.getByRole("option", { name: "غير نشط" }).click();
    await fitsAtPhoneWidth(page, "the accountant's edit form");
    await form.getByTestId("employee-form-save").click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.body).toEqual({ basicSalary: 7000, endDate: "2026-12-31", status: "inactive" });
    await expect.poll(async () => { const r = await row(); return [Number(r.basic_salary), r.status, r.end_date]; }).toEqual([7000, "inactive", "2026-12-31"]);
    await page.getByRole("button", { name: "غير نشط" }).click();
    await expect(page.getByTestId(`employee-status-${id}`)).toHaveText("غير نشط");
    await expect(page.getByTestId(`employee-end-date-${id}`)).not.toHaveText("—");
    await ctx.close();
  });
});
