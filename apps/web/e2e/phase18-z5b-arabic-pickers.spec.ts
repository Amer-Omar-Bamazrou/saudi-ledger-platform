import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * 🔴 Phase 18 final round (owner, 2026-11-04), walk finding 13, register §11.142: "The file picker gets an Arabic label. The
 * date picker: use an Arabic-localised picker if the existing UI library has one." It has one (`components/ui/calendar.tsx`).
 * Browser controls follow the browser's language, so the walk read "No file chosen / Choose File", "mm/dd/yyyy" and
 * "November 2026" inside an Arabic page. In Arabic at 390 px; English keeps the native fields.
 * 🔴 Its OWN tenants, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-z5b-${STAMP}`;
const PENDING_SLUG = `e2e-z5b-pending-${STAMP}`;
const ADMIN = `e2e-z5b-admin-${STAMP}@smoke.local`;
const PENDING = `e2e-z5b-pending-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const ARABIC_MONTHS = /يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر/;

let db: Db;
let adminApi: APIRequestContext;
let pendingApi: APIRequestContext;

async function removeTenants() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug IN ('${SLUG}','${PENDING_SLUG}'))`;
  const users = `(SELECT id FROM users WHERE email IN ('${ADMIN}','${PENDING}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug IN ($1,$2)`, [SLUG, PENDING_SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2)`, [ADMIN, PENDING]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Z5b Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  const pendingOrg = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Z5b Pending', $1, 'pending_review') RETURNING id`, [PENDING_SLUG])).rows[0].id;
  for (const id of [orgId, pendingOrg]) await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Z5b Co',1,'gregorian')`, [id]);
  for (const [email, name, org] of [[ADMIN, "E2E Z5b Admin", orgId], [PENDING, "E2E Z5b Pending", pendingOrg]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [org, id]);
  }
  adminApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  pendingApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await adminApi.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await adminApi.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  expect((await pendingApi.post("/api/auth/login", { data: { email: PENDING, password: PASSWORD } })).ok()).toBeTruthy();
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await adminApi?.dispose();
  await pendingApi?.dispose();
  if (db) {
    await removeTenants();
    await db.end();
  }
});

async function open(browser: Browser, api: APIRequestContext, path: string, lang: "ar" | "en" = "ar"): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  return { page, close: () => ctx.close() };
}

test.describe("Arabic pickers", () => {
  test("🔴 the file picker speaks Arabic, says what is chosen, and the file still reaches the form", async ({ browser }) => {
    const { page, close } = await open(browser, pendingApi, "/verification");
    const picker = page.getByTestId("file-picker").first();
    await expect(picker).toContainText("اختيار ملف");
    await expect(picker).toContainText("لم يُختر ملف");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "z5b-sijill.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 z5b") });
    await expect(picker).toContainText("z5b-sijill.pdf");
    await expect(page.getByRole("button", { name: "رفع" }), "the form holds the file").toBeEnabled();
    await close();
  });

  test("🔴 a date field reads in Arabic, opens an Arabic calendar, and the chosen day reaches the form", async ({ browser }) => {
    const { page, close } = await open(browser, adminApi, "/invoices");
    await page.getByRole("button", { name: "فاتورة جديدة" }).click();
    const dialog = page.getByRole("dialog");
    const trigger = dialog.locator("[data-date-picker]").first();
    await expect(trigger, "the date, in Arabic words").toContainText(ARABIC_MONTHS);
    const native = dialog.locator('input[type="date"]').first();
    const before = await native.inputValue();
    await trigger.click();
    const calendar = page.locator("[data-date-picker-panel]");
    await expect(calendar).toBeVisible();
    await expect(calendar, "the month's name is Arabic").toContainText(ARABIC_MONTHS);
    await expect(calendar).not.toContainText(/January|February|March|April|June|July|August|September|October|November|December/);
    const day = before.endsWith("-15") ? "16" : "15";
    await calendar.getByRole("button", { name: new RegExp(`\\b${day}\\b`) }).first().click();
    await expect(native, "the form's value moved").toHaveValue(`${before.slice(0, 8)}${day}`);
    await close();
  });

  test("🔴 a month field reads in Arabic, and the chosen month reaches the page", async ({ browser }) => {
    const { page, close } = await open(browser, adminApi, "/vat");
    const native = page.getByTestId("vat-period-from");
    const field = page.locator("[data-date-picker]").first();
    await expect(field).toBeVisible();
    await field.click();
    const panel = page.locator("[data-date-picker-panel]");
    await expect(panel).toContainText("يناير");
    await expect(panel).toContainText("ديسمبر");
    await panel.getByRole("button", { name: "مارس" }).click();
    await expect(native.locator("xpath=."), "the field holds March").toHaveValue(/-03$/);
    await close();
  });

  test("English keeps the native fields", async ({ browser }) => {
    const { page, close } = await open(browser, adminApi, "/invoices", "en");
    await page.getByRole("button", { name: "New Invoice" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-date-picker]")).toHaveCount(0);
    const native = dialog.locator('input[type="date"]').first();
    expect(await native.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await close();
  });
});
