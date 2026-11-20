import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 Phase 19A slice 1 (19.4/19.5/19.8) — Session Management, CLICKED: in Arabic at 390 px (the settled layout, no
 * sideways scroll), an admin sees their two sessions with the one in use marked, ends the other (that device's next
 * request is refused), ends a member's sessions (the member is signed out), and the Users page's security trail
 * labels the act in Arabic. Its OWN tenant, removed afterwards.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-p19a-${STAMP}`;
const ADMIN = `e2e-p19a-admin-${STAMP}@smoke.local`;
const MEMBER = `e2e-p19a-member-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let adminHere: APIRequestContext; // the session the page uses
let adminThere: APIRequestContext; // "another device"
let member: APIRequestContext;
let orgId = "";
let memberId = 0;

async function removeTenant() {
  const users = `(SELECT id FROM users WHERE email IN ('${ADMIN}', '${MEMBER}'))`;
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM session_records WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1, $2)`, [ADMIN, MEMBER]);
  await db.query("COMMIT");
}

async function signIn(email: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: "http://localhost:5173", extraHTTPHeaders: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" } });
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
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E P19A Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E P19A Co','1010404040','300000000000003',1,'gregorian')`, [orgId]);
  const adminId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E P19A Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  memberId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E P19A Member',$2,'viewer',true) RETURNING id`, [MEMBER, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active'), ($1,$3,'bookkeeper','active')`, [orgId, adminId, memberId]);
  adminHere = await signIn(ADMIN);
  adminThere = await signIn(ADMIN);
  member = await signIn(MEMBER);
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  for (const c of [adminHere, adminThere, member]) await c?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function open(browser: Browser, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await adminHere.storageState(), viewport: PHONE });
  await ctx.addInitScript(() => { try { localStorage.setItem("ksa_lang", "ar"); } catch { /* the default language */ } });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

test.describe.serial("Phase 19A — Session Management", () => {
  test("🔴 Arabic at 390 px: two sessions, the one in use marked; the member's card; nothing scrolls sideways", async ({ browser }) => {
    const { page, close } = await open(browser, "/security/sessions");
    await expect(page.getByRole("heading", { level: 1, name: "إدارة الجلسات" })).toBeVisible();
    const mine = page.getByTestId("my-sessions");
    await expect(mine.locator('[data-testid^="my-session-"][data-testid$="-current"]')).toHaveText("هذه الجلسة");
    await expect(mine.getByRole("button", { name: "إنهاء هذه الجلسة" })).toHaveCount(1);
    await expect(page.getByTestId("end-other-sessions")).toHaveText("إنهاء جميع الجلسات الأخرى (1)");
    await expect(mine).toContainText("Chrome · Windows");
    await expect(page.getByTestId(`end-member-sessions-${memberId}`)).toHaveText("إنهاء جميع جلساته (1)");
    await fitsAtPhoneWidth(page, "Session Management");
    await close();
  });

  test("🔴 ending the other session: it leaves the list, and that device's next request is refused", async ({ browser }) => {
    expect((await adminThere.get("/api/auth/me")).status(), "anti-vacuity: the other device works first").toBe(200);
    const { page, close } = await open(browser, "/security/sessions");
    await page.getByTestId("my-sessions").getByRole("button", { name: "إنهاء هذه الجلسة" }).click();
    await expect(page.getByTestId("my-sessions-count")).toContainText("1");
    await expect(page.getByTestId("end-other-sessions")).toHaveCount(0);
    expect((await adminThere.get("/api/auth/me")).status()).toBe(401);
    expect((await adminHere.get("/api/auth/me")).status(), "the session in use keeps working").toBe(200);
    await close();
  });

  test("🔴 ending a member's sessions signs the member out, and the security trail labels it in Arabic", async ({ browser }) => {
    expect((await member.get("/api/auth/me")).status(), "anti-vacuity: the member is signed in").toBe(200);
    const { page, close } = await open(browser, "/security/sessions");
    await page.getByTestId(`end-member-sessions-${memberId}`).click();
    await expect(page.getByTestId(`member-${memberId}`)).toHaveCount(0);
    expect((await member.get("/api/auth/me")).status()).toBe(401);
    await page.goto("/users", { waitUntil: "networkidle" });
    await expect(page.getByTestId("security-events").locator('[data-action="session.revoked_all"]').first()).toContainText("إنهاء الجلسات");
    await expect(page.getByTestId("security-events").locator('[data-action="session.revoked"]').first()).toContainText("إنهاء جلسة");
    await close();
  });
});
