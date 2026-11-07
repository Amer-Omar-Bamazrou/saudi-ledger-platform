import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * 🔴 Carry-over Batch 1, numbers and their words in Arabic (the owner, 2026-11-07; the walks' findings):
 *  - N-9: the payroll period's format hint follows the language (it read "الفترة (YYYY-MM)").
 *  - N-11: the customer ageing labels use the app's digits, Latin (they read "١–٣٠ يوم" beside Latin figures).
 *  - W-19: "1 حسابات" reads correctly for one and for many (and "1 accounts" in English).
 * W-21, the PDF's VAT percentage in Eastern digits, is the document's text: `apps/api/src/tests/b1-arabic-numbers-pdf.test.ts`.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-numbers-${STAMP}`;
const ADMIN = `e2e-numbers-admin-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const EASTERN = /[٠-٩]/;

let db: Db;
let api: APIRequestContext;
let customerId = 0;

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

async function ok<T>(res: Promise<{ ok: () => boolean; status: () => number; json: () => Promise<any>; text: () => Promise<string> }>, what: string) {
  const r = await res;
  if (!r.ok()) throw new Error(`${what}: ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Numbers Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Numbers Co','1010404040','300000000000003',1,'gregorian')`, [orgId]);
  const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E Numbers Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, id]);
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  customerId = (await ok<{ id: number }>(api.post("/api/customers", { data: { name: `Numbers Customer ${STAMP}`, nameAr: `عميل الأرقام ${STAMP}` } }), "customer")).id;
  // Exactly ONE bank account, so the count reads "one".
  await ok(api.post("/api/bank-accounts", { data: { name: "Numbers Bank", bankName: "SNB", currency: "SAR", isDefault: true } }), "bank");
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await api?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function open(browser: Browser, lang: "ar" | "en", path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport: lang === "ar" ? PHONE : DESKTOP });
  await ctx.addInitScript((l) => { try { localStorage.setItem("ksa_lang", l); } catch { /* the default language */ } }, lang);
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  return { page, close: () => ctx.close() };
}

test.describe("Arabic numbers and their words", () => {
  test("🔴 N-9: the payroll period's hint is in Arabic in Arabic mode", async ({ browser }) => {
    const { page, close } = await open(browser, "ar", "/payroll");
    await page.getByRole("button", { name: "تشغيل الرواتب" }).click();
    const label = page.getByRole("dialog").getByText(/^الفترة/);
    await expect(label).toBeVisible();
    await expect(label, "no Latin format hint").not.toContainText("YYYY");
    await expect(label, "an Arabic one").toContainText("السنة");
    await close();
  });

  test("🔴 N-11: the customer's ageing labels use Latin digits", async ({ browser }) => {
    const { page, close } = await open(browser, "ar", `/customers/${customerId}`);
    const ageing = page.locator("div.grid", { has: page.getByText("جارٍ", { exact: true }) }).first();
    await expect(ageing).toBeVisible();
    await expect(ageing, "the 1–30 bucket").toContainText("1–30");
    await expect(ageing, "no Eastern digits").not.toContainText(EASTERN);
    await close();
  });

  for (const [lang, one, wrong] of [["ar", "حساب واحد", "1 حسابات"], ["en", "1 account", "1 accounts"]] as const) {
    test(`🔴 W-19: one bank account reads "${one}" (${lang})`, async ({ browser }) => {
      const { page, close } = await open(browser, lang, "/bank-accounts");
      const heading = page.getByRole("heading", { level: 1, name: lang === "ar" ? "الحسابات البنكية" : "Bank Accounts" });
      const subtitle = heading.locator("xpath=following-sibling::p[1]");
      await expect(subtitle).toContainText(one);
      await expect(subtitle).not.toContainText(wrong);
      await close();
    });
  }
});
