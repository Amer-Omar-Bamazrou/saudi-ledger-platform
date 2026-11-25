import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 19B S6 THROUGH THE PAGES — the report builder and saved reports.
 *
 *  - An accountant (English, desktop) builds a report over sales documents: picks four columns, reorders them, runs it
 *    — the table shows exactly those columns in that order, on an invoice the product's own path issued — saves it,
 *    and shares it with viewers.
 *  - A viewer (Arabic, 390 px) finds it under saved reports as someone else's, opens it and sees the same rows; they
 *    are offered no sharing, and the builder offers them only the report data their own role may run.
 *
 * (The rules are held by apps/api/src/tests/s6-report-definitions.test.ts.) 🔴 Its OWN tenant, created and removed here.
 * With S6_SHOTS_DIR set, the two builder screenshots the owner asked for are written there.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-s6rb-${STAMP}`;
const USERS = { admin: `e2e-s6rb-adm-${STAMP}@smoke.local`, accountant: `e2e-s6rb-acc-${STAMP}@smoke.local`, viewer: `e2e-s6rb-view-${STAMP}@smoke.local` } as const;
type Role = keyof typeof USERS;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
// the business day (Asia/Riyadh): the builder's "this calendar month" starts from it
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
const REPORT = `Sales this month ${STAMP}`;
const SHOTS = process.env.S6_SHOTS_DIR;

let db: Db;
const api = {} as Record<Role, APIRequestContext>;
let invoiceNumber = "";

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S6 Builder Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S6 Co','1010707083','319292929292981','1234','King Fahd Road','Al Olaya','Riyadh','12345',1,'gregorian')`, [orgId]);
  for (const role of Object.keys(USERS) as Role[]) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [USERS[role], `E2E S6 ${role}`, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    api[role] = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
    const login = await api[role].post("/api/auth/login", { data: { email: USERS[role], password: PASSWORD } });
    expect(login.ok(), `login ${role}: ${login.status()}`).toBeTruthy();
    expect((await api[role].post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  const post = async (path: string, data: unknown, status = 200) => {
    const r = await api.admin.post(path, { data });
    expect(r.status(), `${path}: ${await r.text()}`).toBe(status);
    return r.json();
  };
  const customer = await post("/api/customers", { name: "عميل المنشئ" }, 201);
  const inv = await post("/api/invoices", { date: TODAY, dueDate: TODAY, customerId: customer.id, items: [{ description: "خدمة", quantity: 1, unitPrice: 2000, vatRate: 15 }] }, 201);
  await post(`/api/invoices/${inv.id}/submit`, {});
  await post(`/api/invoices/${inv.id}/approve`, {});
  invoiceNumber = inv.invoiceNumber;
});

test.afterAll(async () => {
  for (const a of Object.values(api)) await a?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function pageAs(browser: Browser, role: Role, path: string, lang: "ar" | "en", viewport: { width: number; height: number }): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api[role].storageState(), viewport });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  return { page, close: () => ctx.close() };
}

/** A click tied to the request it must send: a click that sends nothing fails here, by name. */
async function clickAndAnswer(page: Page, testId: string, method: string, path: RegExp, status: number) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === method && path.test(new URL(r.url()).pathname)),
    page.getByTestId(testId).click(),
  ]);
  expect(response.status(), `${testId} → ${response.url()}`).toBe(status);
}

const headers = (page: Page) => page.getByTestId("builder-table").locator("thead th").evaluateAll((ths) => ths.map((th) => (th.firstChild?.textContent ?? "").trim()));

test.describe.serial("19B S6 — the report builder and saved reports", () => {
  test("🔴 accountant (English, desktop): builds, reorders, runs, saves and shares a sales report", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "accountant", "/reports/builder", "en", DESKTOP);
    await page.getByTestId("builder-dataset").selectOption("sales_documents");
    await expect(page.getByTestId("builder-all-columns")).toBeVisible();
    for (const key of ["documentNumber", "date", "customerName", "signedTotal"]) await page.getByTestId(`builder-add-${key}`).click();
    // the signed total moves up twice: Number, Signed total, Date, Customer
    await page.getByTestId("builder-up-signedTotal").click();
    await page.getByTestId("builder-up-signedTotal").click();
    await page.getByTestId("builder-sort").selectOption("date");
    await page.getByTestId("builder-sort-direction").selectOption("desc");
    await clickAndAnswer(page, "builder-run", "GET", /^\/api\/reports\/datasets\/sales_documents\/rows$/, 200);
    await expect(page.getByTestId("builder-table")).toBeVisible();
    expect(await headers(page)).toEqual(["Number", "Signed total", "Date", "Customer"]);
    const row = page.getByTestId("builder-row").filter({ hasText: invoiceNumber });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("2,300.00");
    await expect(page.getByTestId("builder-count")).toHaveText("1–1 of 1");

    await page.getByTestId("builder-name").fill(REPORT);
    await clickAndAnswer(page, "builder-save-new", "POST", /^\/api\/report-definitions$/, 201);
    await expect(page).toHaveURL(/\/reports\/builder\?id=\d+$/);
    await expect(page.getByTestId("builder-sharing")).toBeVisible();
    await page.getByTestId("builder-share-viewer").check();
    await clickAndAnswer(page, "builder-share-save", "PUT", /^\/api\/report-definitions\/\d+\/share$/, 200);
    // reopened from the saved list, it is as it was saved — and already run
    await page.goto("/reports/saved", { waitUntil: "networkidle" });
    const item = page.getByTestId("saved-list").locator("li").filter({ hasText: REPORT });
    await expect(item).toContainText("Yours · shared with Viewers");
    await item.getByRole("link", { name: REPORT }).click();
    await expect(page.getByTestId("builder-table")).toBeVisible();
    expect(await headers(page)).toEqual(["Number", "Signed total", "Date", "Customer"]);
    await expect(page.getByTestId("builder-name")).toHaveValue(REPORT);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/builder-en-desktop.png`, fullPage: true });
    await close();
  });

  test("🔴 viewer (Arabic, 390 px): opens the shared report and sees the same rows; no sharing; only their own report data", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "viewer", "/reports/saved", "ar", PHONE);
    const item = page.getByTestId("saved-list").locator("li").filter({ hasText: REPORT });
    await expect(item).toContainText("مشترك من E2E S6 accountant");
    await expect(item.getByRole("button")).toHaveCount(0); // someone else's: no Remove
    await fitsAtPhoneWidth(page, "the saved reports list");
    await item.getByRole("link", { name: REPORT }).click();
    await expect(page.getByTestId("builder-table")).toBeVisible();
    expect(await headers(page)).toEqual(["الرقم", "الإجمالي بالإشارة", "التاريخ", "العميل"]);
    await expect(page.getByTestId("builder-row").filter({ hasText: invoiceNumber })).toHaveCount(1);
    await expect(page.getByTestId("builder-shared-note")).toContainText("مشترك من E2E S6 accountant");
    await expect(page.getByTestId("builder-sharing")).toHaveCount(0);
    await expect(page.getByTestId("builder-save")).toHaveCount(0);
    // the viewer is offered the three viewer datasets (D3) and no other
    expect(await page.getByTestId("builder-dataset").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).toEqual(["journal_lines", "sales_documents", "purchase_documents"]);
    await fitsAtPhoneWidth(page, "the report builder");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/builder-ar-390.png`, fullPage: true });
    await close();
  });
});
