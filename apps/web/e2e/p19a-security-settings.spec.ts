import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * 🔴 Phase 19A slice 3 (19.7) — Security Settings, CLICKED, in Arabic at 390 px: a value past the platform's limit is
 * refused in Arabic; a stricter change saves at once; a weaker one is held — its requester is told another admin
 * approves and is offered no approval; the second admin approves it. Then the setting DOES something: with two-step
 * verification required for everyone, a fresh sign-in lands on the set-up screen and nothing else opens (the
 * forced-enrolment screen, which the suite's `optional` enforcement otherwise never shows).
 * Its OWN tenant with two admins, removed afterwards.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-p19s-${STAMP}`;
const ADMIN1 = `e2e-p19s-a1-${STAMP}@smoke.local`;
const ADMIN2 = `e2e-p19s-a2-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let one: APIRequestContext;
let two: APIRequestContext;
let orgId = "";

async function removeTenant() {
  const users = `(SELECT id FROM users WHERE email IN ('${ADMIN1}', '${ADMIN2}'))`;
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  for (const t of ["session_records", "user_mfa_recovery_codes", "user_mfa_factors"]) await db.query(`DELETE FROM ${t} WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1, $2)`, [ADMIN1, ADMIN2]);
  await db.query("COMMIT");
}

async function signIn(email: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `sign-in ${email}`).toBeTruthy();
  expect((await ctx.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  return ctx;
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E P19S Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E P19S Co','1010404040','300000000000003',1,'gregorian')`, [orgId]);
  for (const [email, name] of [[ADMIN1, "E2E P19S Admin One"], [ADMIN2, "E2E P19S Admin Two"]]) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, id]);
  }
  one = await signIn(ADMIN1);
  two = await signIn(ADMIN2);
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await one?.dispose();
  await two?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function open(browser: Browser, state: APIRequestContext | null, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ ...(state ? { storageState: await state.storageState() } : {}), viewport: PHONE });
  await ctx.addInitScript(() => { try { localStorage.setItem("ksa_lang", "ar"); } catch { /* the default language */ } });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}
const fits = async (page: Page) => {
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "no horizontal scroll at 390 px").toBeLessThanOrEqual(0);
};
const stored = async () => (await db.query(`SELECT mfa_required_for_all, session_lifetime_hours, idle_timeout_minutes FROM org_security_settings WHERE organization_id = $1`, [orgId])).rows[0];

test.describe.serial("Phase 19A — Security Settings", () => {
  test("🔴 the platform's limit is named in Arabic; a stricter change saves at once", async ({ browser }) => {
    const { page, close } = await open(browser, one, "/security/settings");
    await expect(page.getByRole("heading", { level: 1, name: "إعدادات الأمان" })).toBeVisible();
    await expect(page.getByTestId("setting-lifetime")).toHaveValue("12");
    await expect(page.getByTestId("setting-idle")).toHaveValue("480");
    await expect(page.getByTestId("setting-mfa-all")).not.toBeChecked();
    await expect(page.getByTestId("security-settings-form")).toContainText("المسؤولون القادرون على البت: 2");
    await fits(page);
    await page.getByTestId("setting-lifetime").fill("13");
    await page.getByTestId("security-settings-save").click();
    await expect(page.getByTestId("security-settings-error")).toContainText("حدّ المنصة");
    expect(await stored(), "refused: nothing written").toBeUndefined();
    await page.getByTestId("setting-lifetime").fill("8");
    await page.getByTestId("setting-idle").fill("60");
    await page.getByTestId("setting-mfa-all").check();
    await page.getByTestId("security-settings-save").click();
    await expect(page.getByTestId("security-settings-notice")).toHaveText("تم الحفظ.");
    expect(await stored()).toEqual({ mfa_required_for_all: true, session_lifetime_hours: 8, idle_timeout_minutes: 60 });
    await close();
  });

  test("🔴 a weaker change is HELD: its requester is told another admin approves, and is offered no approval", async ({ browser }) => {
    const { page, close } = await open(browser, one, "/security/settings");
    await page.getByTestId("setting-lifetime").fill("10");
    await page.getByTestId("security-settings-save").click();
    await expect(page.getByTestId("security-settings-notice")).toContainText("ينتظر اعتماد مسؤول ثانٍ");
    const pending = page.getByTestId("security-settings-pending");
    await expect(pending).toBeVisible();
    await expect(pending.getByTestId("security-settings-pending-after")).toContainText("مدة الجلسة: 10 ساعة");
    await expect(pending.getByTestId("security-settings-own-request")).toBeVisible();
    await expect(pending.getByTestId("security-settings-approve")).toHaveCount(0);
    await expect(page.getByTestId("security-settings-save")).toBeDisabled();
    expect((await stored()).session_lifetime_hours, "held: nothing changed").toBe(8);
    await fits(page);
    await close();
  });

  test("🔴 the second admin approves it, and the settings change", async ({ browser }) => {
    const { page, close } = await open(browser, two, "/security/settings");
    const pending = page.getByTestId("security-settings-pending");
    await expect(pending).toContainText("E2E P19S Admin One");
    await pending.getByTestId("security-settings-approve").click();
    await expect(page.getByTestId("security-settings-notice")).toContainText("تم الاعتماد");
    await expect(page.getByTestId("security-settings-pending")).toHaveCount(0);
    await expect(page.getByTestId("setting-lifetime")).toHaveValue("10");
    expect((await stored()).session_lifetime_hours).toBe(10);
    // the security trail labels the act in Arabic
    await page.goto("/users", { waitUntil: "networkidle" });
    await expect(page.getByTestId("security-events").locator('[data-action="security_settings.changed"]').first()).toContainText("تغيير إعدادات الأمان");
    await close();
  });

  test("🔴 'everyone' is ENFORCED: a fresh sign-in lands on the set-up screen, and nothing else opens until it is done", async ({ browser }) => {
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
    const { page, close } = await open(browser, null, "/login");
    await page.locator("#email").fill(ADMIN2);
    await page.locator("#password").fill(PASSWORD);
    await page.locator("#password").press("Enter");
    await expect(page.getByTestId("mfa-enrol-step")).toBeVisible();
    await expect(page.getByTestId("mfa-enrol-step")).toContainText("دورك يتطلب التحقق بخطوتين");
    await fits(page);
    await page.goto("/invoices", { waitUntil: "networkidle" });
    await expect(page.getByTestId("mfa-enrol-step"), "a direct visit lands on the same step").toBeVisible();
    const refused = await page.request.get("/api/invoices");
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe("mfa_enrolment_required");
    await page.getByTestId("mfa-enrol-begin").click();
    await expect(page.getByTestId("mfa-qr")).toBeVisible();
    await fits(page);
    await close();
  });
});
