import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 ITEM 3 THROUGH THE CLIENT (owner, 2026-11-25). Arabic, 390 px. A Saudi customer's VAT number and a Saudi supplier's
 * CR number typed wrong into their own forms: the server refuses, the page says which number and why IN ARABIC, and
 * nothing is saved; the corrected number saves. (The rules and the edit/import paths: tests/party-identifiers.test.ts.)
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-partyid-${STAMP}`;
const ADMIN = `e2e-partyid-adm-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let api: APIRequestContext;
let orgId = "";

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
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Party Ids Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Party Ids Co','1010707073','319292929292973','1234','King Fahd Road','Al Olaya','Riyadh','12345',1,'gregorian')`, [orgId]);
  const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E PartyId admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, id]);
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
  const login = await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } });
  expect(login.ok(), `login: ${login.status()}`).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
});

test.afterAll(async () => {
  await api?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function pageAs(browser: Browser, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

const count = async (table: "customers" | "vendors") => Number((await db.query(`SELECT count(*)::int n FROM ${table} WHERE organization_id = $1`, [orgId])).rows[0].n);

test.describe.serial("item 3 — VAT and CR numbers through the forms (Arabic, 390 px)", () => {
  test("🔴 the customer form: a 14-digit VAT number is refused in Arabic, naming the number and why; nothing saved; corrected, it saves", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "/customers");
    await page.getByTestId("customer-new").click();
    await page.getByTestId("customer-form-name").fill("شركة الأرقام");
    await page.getByTestId("customer-form-taxNumber").fill("30000000000003");
    await page.getByTestId("customer-form-save").click();
    await expect(page.getByText("الرقم الضريبي (رقم التسجيل في ضريبة القيمة المضافة) «30000000000003» غير صحيح: يتكون من 14 رقمًا").first()).toBeVisible();
    expect(await count("customers")).toBe(0);
    await fitsAtPhoneWidth(page, "the customer form with the refusal");
    await page.getByTestId("customer-form-taxNumber").fill("300000000000003");
    await page.getByTestId("customer-form-save").click();
    await expect.poll(() => count("customers")).toBe(1);
    await close();
  });

  test("🔴 the supplier form: a 5-digit CR number is refused in Arabic, naming the number and why; nothing saved", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "/vendors");
    await page.getByRole("button", { name: "مورد جديد" }).click();
    await page.getByTestId("vendor-name").fill("Numbers Supplier");
    await page.getByTestId("vendor-crNumber").fill("10101");
    await page.getByTestId("vendor-create").click();
    await expect(page.getByText("رقم السجل التجاري «10101» غير صحيح: يتكون من 5 أرقام").first()).toBeVisible();
    expect(await count("vendors")).toBe(0);
    await close();
  });
});
