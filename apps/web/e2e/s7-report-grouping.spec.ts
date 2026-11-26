import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 19B 19.12 THROUGH THE PAGES — grouping and subtotals in the report builder.
 *
 *  - An accountant (English, desktop) groups sales documents by customer: the subtotals table shows one line per
 *    customer — a one-invoice customer's subtotal is that invoice — and a total that is their sum; saves and shares it.
 *  - A viewer (Arabic, 390 px) opens the shared report: the same subtotals, in Arabic, fitting the phone; then groups
 *    journal lines by account and is told in words that the report has no grand total.
 *
 * (The rules are held by apps/api/src/tests/s7-report-grouping.test.ts.) 🔴 Its OWN tenant, created and removed here.
 * With S7_SHOTS_DIR set, screenshots are written there.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-s7gr-${STAMP}`;
const USERS = { admin: `e2e-s7gr-adm-${STAMP}@smoke.local`, accountant: `e2e-s7gr-acc-${STAMP}@smoke.local`, viewer: `e2e-s7gr-view-${STAMP}@smoke.local` } as const;
type Role = keyof typeof USERS;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
// the business day (Asia/Riyadh): the builder's "this calendar month" starts from it
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
const REPORT = `Sales by customer ${STAMP}`;
const SHOTS = process.env.S7_SHOTS_DIR;

let db: Db;
const api = {} as Record<Role, APIRequestContext>;

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S7 Grouping Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S7 Co','1010707091','319292929292973','1234','King Fahd Road','Al Olaya','Riyadh','12345',1,'gregorian')`, [orgId]);
  for (const role of Object.keys(USERS) as Role[]) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [USERS[role], `E2E S7 ${role}`, hash])).rows[0].id;
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
  for (const [name, prices] of [["عميل أول", [1000, 33.33]], ["Second customer", [400.2]]] as const) {
    const customer = await post("/api/customers", { name }, 201);
    for (const unitPrice of prices) {
      const inv = await post("/api/invoices", { date: TODAY, dueDate: TODAY, customerId: customer.id, items: [{ description: "خدمة", quantity: 1, unitPrice, vatRate: 15 }] }, 201);
      await post(`/api/invoices/${inv.id}/submit`, {});
      await post(`/api/invoices/${inv.id}/approve`, {});
    }
  }
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

/** The subtotals table as text: one array per line (the formatter's no-break space read as a space). */
const groupLines = (page: Page) =>
  page.getByTestId("builder-groups").locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => (td.textContent ?? "").replace(/\s+/g, " ").trim())));

test.describe.serial("19B 19.12 — grouping and subtotals in the builder", () => {
  test("🔴 accountant (English, desktop): groups sales by customer, sees each subtotal and their total, saves and shares", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "accountant", "/reports/builder", "en", DESKTOP);
    await page.getByTestId("builder-dataset").selectOption("sales_documents");
    for (const key of ["customerName", "documentNumber", "signedTotal"]) await page.getByTestId(`builder-add-${key}`).click();
    // only what the data offers as a grouping is listed
    const offered = await page.getByTestId("builder-group").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(offered).toEqual(["", "documentType", "date", "status", "customerName"]);
    await page.getByTestId("builder-group").selectOption("customerName");
    const [response] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/reports/datasets/sales_documents/rows"),
      page.getByTestId("builder-run").click(),
    ]);
    expect(new URL(response.url()).searchParams.get("group")).toBe("customerName");
    await expect(page.getByTestId("builder-groups")).toBeVisible();
    // 1000 + 33.33 with 15% VAT = 1,150.00 + 38.33; the one-invoice customer's subtotal is its invoice: 460.23
    expect(await groupLines(page)).toEqual([
      ["Second customer", "1", "SAR 460.23"],
      ["عميل أول", "2", "SAR 1,188.33"],
      ["Total", "3", "SAR 1,648.56"],
    ]);
    await expect(page.getByTestId("builder-groups-no-grand")).toHaveCount(0);
    await expect(page.getByTestId("builder-row")).toHaveCount(3);
    // the rows come group by group
    expect(await page.getByTestId("builder-row").evaluateAll((trs) => trs.map((tr) => tr.querySelector("td")?.textContent))).toEqual(["Second customer", "عميل أول", "عميل أول"]);

    await page.getByTestId("builder-name").fill(REPORT);
    await clickAndAnswer(page, "builder-save-new", "POST", /^\/api\/report-definitions$/, 201);
    await expect(page).toHaveURL(/\/reports\/builder\?id=\d+$/);
    await page.getByTestId("builder-share-viewer").check();
    await clickAndAnswer(page, "builder-share-save", "PUT", /^\/api\/report-definitions\/\d+\/share$/, 200);
    // reopened, it is still grouped — and already run
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("builder-group")).toHaveValue("customerName");
    await expect(page.getByTestId("builder-groups-grand")).toContainText("1,648.56");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/builder-grouped_accountant_en_1280.png`, fullPage: true });
    await close();
  });

  test("🔴 viewer (Arabic, 390 px): the shared report's subtotals in Arabic; journal lines by account have no grand total, in words", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "viewer", "/reports/saved", "ar", PHONE);
    await page.getByTestId("saved-list").locator("li").filter({ hasText: REPORT }).getByRole("link", { name: REPORT }).click();
    await expect(page.getByTestId("builder-groups")).toBeVisible();
    await expect(page.getByTestId("builder-groups").locator("h2")).toHaveText("المجاميع الفرعية حسب العميل");
    expect(await groupLines(page)).toEqual([
      ["Second customer", "1", "460.23 ر.س"],
      ["عميل أول", "2", "1,188.33 ر.س"],
      ["الإجمالي", "3", "1,648.56 ر.س"],
    ]);
    await fitsAtPhoneWidth(page, "the grouped report");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/builder-grouped_viewer_ar_390.png`, fullPage: true });

    await page.getByTestId("builder-dataset").selectOption("journal_lines");
    await page.getByTestId("builder-group").selectOption("accountId");
    await clickAndAnswer(page, "builder-run", "GET", /^\/api\/reports\/datasets\/journal_lines\/rows$/, 200);
    await expect(page.getByTestId("builder-groups-no-grand")).toHaveText("لا يوجد إجمالي عام لهذا التقرير: مجموع كل سطوره ليس رقماً من أرقام الدفاتر.");
    await expect(page.getByTestId("builder-groups-grand")).toHaveCount(0);
    expect(await page.getByTestId("builder-groups-group").count()).toBeGreaterThan(2);
    await fitsAtPhoneWidth(page, "journal lines grouped by account");
    await close();
  });
});
