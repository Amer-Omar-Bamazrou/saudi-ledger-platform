import { test, expect, request as pwRequest, type APIRequestContext, type Browser } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 19B S3 (v4 §6.3, D2; owner 2026-11-23, item 5): "vendor and employee IBANs held at creation and on change, under
 * the D2 rule and its fallback, including the bookkeeper's employee IBAN entry" — walked, in Arabic at 390 px.
 *
 * The tenant has an ACCOUNTANT (the one member who can approve bank details) and a BOOKKEEPER (who cannot).
 *  1. The bookkeeper adds an employee WITH an IBAN through the form: the IBAN leaves the page, the employee is saved
 *     WITHOUT it, the request is held, and the list says the IBAN waits.
 *  2. The bookkeeper reads the held change in Company settings as its LAST FOUR, with no Approve (a bookkeeper cannot
 *     approve), and the full IBAN is nowhere on the page.
 *  3. The accountant approves it there: it reads approved, the employee's IBAN is in place, the waiting line is gone.
 *  4. The bookkeeper reads it approved — still only as its last four.
 *  5. (EN desktop) A supplier's IBAN entered by the accountant — the only member who could approve it — applies at
 *     once, the FALLBACK: recorded closed with its reason, and the supplier's row says it applied without a second
 *     approver and who entered it. (Created over the API; the screens that READ it are what this walks.)
 *
 * The API suite proves the rule on every path (`s3-party-iban-hold.test.ts`). 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-s3-${STAMP}`;
const ACCOUNTANT = `e2e-s3-acc-${STAMP}@smoke.local`;
const KEEPER = `e2e-s3-keeper-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const NUMBER = `S3-${String(STAMP).slice(-6)}`;
const IBAN = "SA0380000000608010167519";
const LAST4 = `•••• ${IBAN.slice(-4)}`;
const SUPPLIER = `E2E S3 Supplier ${STAMP}`;
const SUPPLIER_IBAN = "SA4420000001234567891234";

let db: Db;
let accApi: APIRequestContext;
let keeperApi: APIRequestContext;
let orgId = "";
let keeperId = 0;

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
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S3 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S3 Co',1,'gregorian')`, [orgId]);
  for (const [email, name, role] of [[ACCOUNTANT, "E2E S3 Accountant", "accountant"], [KEEPER, "E2E S3 Keeper", "bookkeeper"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    if (role === "bookkeeper") keeperId = id;
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

async function signedIn(browser: Browser, api: APIRequestContext, path: string, lang: "ar" | "en", viewport = PHONE) {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  return { ctx, page };
}

const employee = async () => (await db.query(`SELECT id, iban FROM employees WHERE organization_id = $1 AND employee_number = $2`, [orgId, NUMBER])).rows[0];
const requestsOf = async (column: "employee_id" | "vendor_id", id: number) =>
  (await db.query(`SELECT id, kind, status, at_creation, requested_by, reason FROM bank_detail_change_requests WHERE ${column} = $1 ORDER BY id`, [id])).rows;

test.describe.serial("19B S3 — a supplier's and an employee's IBAN is held, walked", () => {
  test("🔴 AR phone: a bookkeeper's employee IBAN leaves the page, the employee is saved WITHOUT it, and it waits", async ({ browser }) => {
    const { ctx, page } = await signedIn(browser, keeperApi, "/employees", "ar");
    const sent: Record<string, unknown>[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/employees") sent.push(JSON.parse(r.postData() ?? "{}"));
    });
    await page.getByTestId("employee-add").click();
    const form = page.getByTestId("employee-form");
    await expect(form).toBeVisible();
    await form.getByTestId("employee-form-employeeNumber").fill(NUMBER);
    await form.getByTestId("employee-form-name").fill("Salem Held-IBAN");
    await form.getByTestId("employee-form-jobTitle").fill("Clerk");
    await form.getByTestId("employee-form-department").fill("Finance");
    await form.getByTestId("employee-form-iban").fill(IBAN);
    await fitsAtPhoneWidth(page, "the employee form");
    await form.getByTestId("employee-form-save").click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.iban, "the client sends the IBAN the bookkeeper typed").toBe(IBAN);
    await expect(page.getByText("تم الحفظ — الآيبان بانتظار الاعتماد").first()).toBeVisible();

    await expect.poll(async () => (await employee())?.id ?? null).not.toBeNull();
    const { id, iban } = await employee();
    expect(iban, "saved WITHOUT the IBAN").toBeNull();
    const held = await requestsOf("employee_id", id);
    expect(held.map((r) => [r.kind, r.status, r.at_creation, r.requested_by])).toEqual([["employee_iban", "pending", true, keeperId]]);
    await expect(page.getByTestId(`employee-iban-${id}-pending`)).toHaveText("تغيير الآيبان بانتظار الاعتماد");
    await fitsAtPhoneWidth(page, "the employee list with a held IBAN");
    await ctx.close();
  });

  test("🔴 AR phone: the bookkeeper reads the held change as its last four, cannot approve it, and the full IBAN is nowhere on the page", async ({ browser }) => {
    const { id } = await employee();
    const [held] = await requestsOf("employee_id", id);
    const { ctx, page } = await signedIn(browser, keeperApi, "/company", "ar");
    const row = page.getByTestId(`bank-detail-change-${held.id}`);
    await expect(row).toHaveAttribute("data-status", "pending");
    await expect(page.getByTestId(`bank-detail-change-status-${held.id}`)).toHaveText("بانتظار اعتماد محاسب أو مسؤول");
    await expect(row).toContainText(`بلا آيبان → ${LAST4}`);
    await expect(row).toContainText("يعتمد محاسب أو مسؤول هذا التغيير أو يرفضه.");
    await expect(page.getByTestId(`bank-detail-approve-${held.id}`), "a bookkeeper cannot approve").toHaveCount(0);
    await expect(page.getByTestId(`bank-detail-reject-${held.id}`)).toHaveCount(0);
    expect(await page.content(), "the full IBAN is not in the page").not.toContain(IBAN);
    await fitsAtPhoneWidth(page, "Company settings, a held change");
    await ctx.close();
  });

  test("🔴 AR phone: the accountant approves it — it reads approved, the IBAN is in place, and the waiting line is gone", async ({ browser }) => {
    const { id } = await employee();
    const [held] = await requestsOf("employee_id", id);
    const { ctx, page } = await signedIn(browser, accApi, "/company", "ar");
    const row = page.getByTestId(`bank-detail-change-${held.id}`);
    await expect(row).toContainText(`بلا آيبان → ${IBAN}`); // an accountant reads an employee's IBAN in full
    await page.getByTestId(`bank-detail-approve-${held.id}`).click();
    await expect(page.getByText("تمت الموافقة على التغيير وتطبيقه").first()).toBeVisible();
    await expect(row).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId(`bank-detail-change-status-${held.id}`)).toHaveText("تمت الموافقة");
    expect((await employee()).iban, "the employee's IBAN is in place").toBe(IBAN);

    await page.goto("/employees", { waitUntil: "networkidle" });
    await expect(page.getByText("Salem Held-IBAN").first()).toBeVisible();
    await expect(page.getByTestId(`employee-iban-${id}-pending`), "nothing waits any more").toHaveCount(0);
    await ctx.close();
  });

  test("🔴 AR phone: the bookkeeper reads it approved — still only as its last four", async ({ browser }) => {
    const { id } = await employee();
    const [held] = await requestsOf("employee_id", id);
    const { ctx, page } = await signedIn(browser, keeperApi, "/company", "ar");
    const row = page.getByTestId(`bank-detail-change-${held.id}`);
    await expect(row).toHaveAttribute("data-status", "approved");
    await expect(row).toContainText(`بلا آيبان → ${LAST4}`);
    await expect(row).toContainText("E2E S3 Accountant");
    expect(await page.content(), "the full IBAN is not in the page").not.toContain(IBAN);
    await ctx.close();
  });

  test("🔴 EN desktop: the only member who could approve it enters a supplier's IBAN — it applies at once, and the supplier says so", async ({ browser }) => {
    const res = await accApi.post("/api/vendors", { data: { name: SUPPLIER, residency: "resident", iban: SUPPLIER_IBAN } });
    expect(res.status(), await res.text()).toBe(201);
    const made = await res.json();
    expect([made.iban, made.pendingBankDetailChanges]).toEqual([SUPPLIER_IBAN, []]);
    const rows = await requestsOf("vendor_id", made.id);
    expect(rows.map((r) => [r.kind, r.status, r.at_creation, r.reason])).toEqual([
      ["vendor_iban", "applied_without_second_approver", true, "no other member holds a role that can approve bank details"],
    ]);

    const { ctx, page } = await signedIn(browser, accApi, "/vendors", "en", DESKTOP);
    const line = page.getByTestId(`vendor-iban-${made.id}-fallback`);
    await expect(line).toContainText("IBAN applied without a second approver");
    await expect(line).toContainText("E2E S3 Accountant");

    await page.goto("/company", { waitUntil: "networkidle" });
    const id = rows[0].id;
    await expect(page.getByTestId(`bank-detail-change-${id}`)).toHaveAttribute("data-status", "applied_without_second_approver");
    await expect(page.getByTestId(`bank-detail-change-status-${id}`)).toHaveText("Applied without a second approver");
    await expect(page.getByTestId(`bank-detail-change-fallback-${id}`)).toHaveText("No other member holds a role that can approve bank details.");
    await ctx.close();
  });
});
