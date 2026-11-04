import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * 🔴 Phase 18 final round (owner, 2026-11-04), walk finding 4, register §11.139: "VAT return: it opens on the current VAT
 * period, never on all-time totals. If all-time is ever shown, it says so in words."
 *
 * The walk read Output VAT 885.00 with empty date fields, which can be taken for this month, which was 0.00.
 * Here: an issued invoice in an OLD month carries 150.00 of VAT. Opened with no period, the page shows the current period
 * (by the company's own VAT period) and 0.00. All-time is reached only by asking, and then 150.00 shows with words beside
 * it; choosing the old month moves the figure too. In Arabic at 390 px. 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-z6-${STAMP}`;
const ADMIN = `e2e-z6-admin-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

/** Today as the product reads it: the Riyadh calendar day. */
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
const YEAR = Number(TODAY.slice(0, 4));
const MONTH = Number(TODAY.slice(5, 7));
const THIS_MONTH = TODAY.slice(0, 7);
const QUARTER_START = Math.floor((MONTH - 1) / 3) * 3 + 1;
const pad = (n: number) => String(n).padStart(2, "0");
const QUARTER_FROM = `${YEAR}-${pad(QUARTER_START)}`;
const QUARTER_TO = `${YEAR}-${pad(QUARTER_START + 2)}`;
const OLD_MONTH = `${YEAR - 1}-03`;

let db: Db;
let api: APIRequestContext;
let companyId = "";

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email = '${ADMIN}')`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email = $1`, [ADMIN]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Z6 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  companyId = (await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Z6 Co','1010404040','300000000000003',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
  const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E Z6 Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, id]);
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  const customer = await (await api.post("/api/customers", { data: { name: `Z6 Customer ${STAMP}` } })).json();
  const bank = await api.post("/api/bank-accounts", { data: { name: "Z6 Bank", bankName: "SNB", currency: "SAR", isDefault: true } });
  expect(bank.ok(), await bank.text()).toBeTruthy();
  const invoice = await api.post("/api/invoices", { data: { invoiceNumber: `Z6-INV-${STAMP}`, date: `${OLD_MONTH}-10`, dueDate: `${OLD_MONTH}-20`, customerId: customer.id,
    items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] } });
  expect(invoice.ok(), await invoice.text()).toBeTruthy();
  const issued = await api.post(`/api/invoices/${(await invoice.json()).id}/approve`);
  expect(issued.ok(), await issued.text()).toBeTruthy();
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await api?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function arabicPhone(browser: Browser, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

const setVatPeriod = (period: "monthly" | "quarterly" | null) => db.query(`UPDATE companies SET vat_tax_period = $1 WHERE id = $2`, [period, companyId]);
const outputVat = (page: Page) => page.locator("p", { hasText: "خانة 8" }).first().locator("xpath=following-sibling::p[1]");

test.describe.serial("the VAT return's opening period", () => {
  test("🔴 a monthly company opens on this month: its fields, its figure and its words", async ({ browser }) => {
    await setVatPeriod("monthly");
    const { page, close } = await arabicPhone(browser, "/vat");
    await expect(page.getByTestId("vat-period-from")).toHaveValue(THIS_MONTH);
    await expect(page.getByTestId("vat-period-to")).toHaveValue(THIS_MONTH);
    await expect(outputVat(page), "the old month's VAT is not in this period").toContainText("0.00");
    await expect(outputVat(page)).not.toContainText("150.00");
    await expect(page.getByTestId("vat-period-words")).toContainText(THIS_MONTH);
    await close();
  });

  test("🔴 a quarterly company opens on this quarter", async ({ browser }) => {
    await setVatPeriod("quarterly");
    const { page, close } = await arabicPhone(browser, "/vat");
    await expect(page.getByTestId("vat-period-from")).toHaveValue(QUARTER_FROM);
    await expect(page.getByTestId("vat-period-to")).toHaveValue(QUARTER_TO);
    await close();
  });

  test("🔴 a company with no VAT period opens on this month and says the period is not set", async ({ browser }) => {
    await setVatPeriod(null);
    const { page, close } = await arabicPhone(browser, "/vat");
    await expect(page.getByTestId("vat-period-from")).toHaveValue(THIS_MONTH);
    await expect(page.getByTestId("vat-period-words")).toContainText("لم تُحدَّد");
    await close();
  });

  test("🔴 all-time is reached only by asking, shows the figure, and says so in words; a chosen month moves the figure too", async ({ browser }) => {
    await setVatPeriod("monthly");
    const { page, close } = await arabicPhone(browser, "/vat");
    await page.getByTestId("vat-period-all").click();
    await expect(page.getByTestId("vat-period-from")).toHaveValue("");
    await expect(outputVat(page)).toContainText("150.00");
    await expect(page.getByTestId("vat-period-words"), "the words for all-time").toContainText("كل الفترات");
    await page.reload({ waitUntil: "networkidle" });
    await expect(outputVat(page), "and the choice survives a reload").toContainText("150.00");
    await page.getByTestId("vat-period-from").fill(OLD_MONTH);
    await page.getByTestId("vat-period-to").fill(OLD_MONTH);
    await expect(outputVat(page)).toContainText("150.00");
    await expect(page.getByTestId("vat-period-words"), "a chosen period is not all-time").not.toContainText("كل الفترات");
    await close();
  });
});
