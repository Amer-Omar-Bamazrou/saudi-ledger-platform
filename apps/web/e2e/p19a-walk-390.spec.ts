import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Locator, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";
import { base32Decode, currentTotpStep, totpAt } from "../../api/src/lib/totp";

/**
 * 🔴 Phase 19A exit — the WALK of every new screen, in Arabic at 390 px, with the WORST values planted rather than
 * hoped for: a 70-character email with no break in it, a full-length IPv6 sign-in address. On every screen nothing
 * scrolls sideways, and (owner, 2026-11-20) a long unbroken value breaks only where it would overflow
 * (`overflow-wrap: anywhere`) on the VALUE only — the Arabic beside it never breaks mid-word (`word-break: normal`).
 *
 * Screens: Session Management (yours and the members'), Two-Step Verification (status and set-up), the code step of a
 * sign-in, Security Settings (with a change held), the security trail on the Users page, and the operator panel's
 * sessions, reset and platform cards. Its OWN tenant and operator, removed afterwards.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-p19w-${STAMP}`;
const LONG = "averyveryverylonglocalpartwithnobreakanywhereinit";
const ADMIN = `e2e-p19w-${STAMP}-${LONG}@smoke.local`;
const ADMIN2 = `e2e-p19w-two-${STAMP}@smoke.local`;
const MEMBER = `e2e-p19w-m-${STAMP}-${LONG}@smoke.local`;
const OPERATOR = `e2e-p19w-op-${STAMP}-${LONG}@smoke.local`;
const IPV6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const EMAILS = [ADMIN, ADMIN2, MEMBER, OPERATOR];

let db: Db;
let admin: APIRequestContext;
let admin2: APIRequestContext;
let member: APIRequestContext;
let op: APIRequestContext;
let orgId = "";
let memberId = 0;

async function removeTenant() {
  const users = `(SELECT id FROM users WHERE email IN (${EMAILS.map((e) => `'${e}'`).join(",")}))`;
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
  await db.query(`DELETE FROM platform_operators WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  for (const t of ["session_records", "user_mfa_recovery_codes", "user_mfa_factors"]) await db.query(`DELETE FROM ${t} WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email = ANY($1)`, [EMAILS]);
  await db.query("COMMIT");
}

async function signIn(email: string, org = true): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  const res = await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } });
  expect(res.ok(), `sign-in ${email}: ${res.status()} ${await res.text()}`).toBeTruthy();
  if (org) expect((await ctx.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  return ctx;
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E P19W Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E P19W Co','1010404040','300000000000003',1,'gregorian')`, [orgId]);
  const mk = async (email: string, name: string, role: string | null) => {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id as number;
    if (role) await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    return id;
  };
  await mk(ADMIN, "مسؤول تجربة الممشى", "admin");
  await mk(ADMIN2, "مسؤول ثانٍ للممشى", "admin");
  memberId = await mk(MEMBER, "محاسب تجربة الممشى", "bookkeeper");
  const opId = await mk(OPERATOR, "مشغّل تجربة الممشى", null);
  await db.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [opId]);
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
  admin = await signIn(ADMIN);
  admin2 = await signIn(ADMIN2);
  member = await signIn(MEMBER);
  op = await signIn(OPERATOR, false);
  // the WORST sign-in address: a full-length IPv6 (a fixture — the record's origin is fixed by its guard)
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  await db.query(`UPDATE session_records SET ip_address = $1 WHERE user_id IN (SELECT id FROM users WHERE email = ANY($2))`, [IPV6, EMAILS]);
  await db.query("COMMIT");
  // a security event whose actor is the long email (an admin ends the member's sessions), and a held settings change
  expect((await admin.post(`/api/auth/users/${memberId}/sessions/end`)).ok()).toBeTruthy();
  expect((await admin.put(`/api/orgs/${orgId}/security-settings`, { data: { mfaRequiredForAll: false, sessionLifetimeHours: 8, idleTimeoutMinutes: 60 } })).ok()).toBeTruthy();
  expect((await admin.put(`/api/orgs/${orgId}/security-settings`, { data: { mfaRequiredForAll: false, sessionLifetimeHours: 9, idleTimeoutMinutes: 60 } })).status()).toBe(202);
  member = await signIn(MEMBER);
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%' OR key LIKE 'mfa%'`);
});

test.afterAll(async () => {
  for (const c of [admin, admin2, member, op]) await c?.dispose();
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
/** Nothing clipped sideways at 390 px: the document, the app's content area, an open dialog (e2e/phoneFit.ts). */
const fits = (page: Page, where: string) => fitsAtPhoneWidth(page, where);
const style = (l: Locator, prop: "overflowWrap" | "wordBreak") => l.evaluate((el, p) => getComputedStyle(el)[p as "overflowWrap"], prop);
/** The VALUE breaks only where it would overflow; the line it sits in keeps normal word breaking (the Arabic). */
async function valueOnly(value: Locator, line: Locator | null, what: string) {
  await expect(value, what).toBeVisible();
  expect(await style(value, "overflowWrap"), `${what}: the value breaks only where it would overflow`).toBe("anywhere");
  expect(await style(value, "wordBreak"), `${what}: the value is not broken everywhere`).toBe("normal");
  if (line) expect(await style(line, "wordBreak"), `${what}: the Arabic beside it never breaks mid-word`).toBe("normal");
  await value.scrollIntoViewIfNeeded();
  await expect(value, `${what}: on screen`).toBeInViewport({ ratio: 1 });
}

test.describe.serial("Phase 19A — the walk of every new screen, Arabic, 390 px, worst values", () => {
  test("Session Management: your sessions (a full IPv6) and the members' (a 70-character email)", async ({ browser }) => {
    const { page, close } = await open(browser, admin, "/security/sessions");
    await expect(page.getByRole("heading", { level: 1, name: "إدارة الجلسات" })).toBeVisible();
    const ip = page.getByTestId("my-sessions").getByText(IPV6, { exact: true }).first();
    await valueOnly(ip, null, "sign-in IP");
    const email = page.getByTestId(`member-${memberId}`).getByText(MEMBER, { exact: true });
    await valueOnly(email, null, "member email");
    await fits(page, "Session Management");
    await close();
  });

  test("Two-Step Verification: status, then set-up with the key shown", async ({ browser }) => {
    const { page, close } = await open(browser, admin, "/security/two-step");
    await expect(page.getByRole("heading", { level: 1, name: "التحقق بخطوتين" })).toBeVisible();
    await fits(page, "Two-Step Verification (status)");
    await page.getByTestId("mfa-enrol-begin").click();
    const key = page.getByTestId("mfa-secret");
    await valueOnly(key, null, "the key to type");
    await fits(page, "Two-Step Verification (set-up)");
    await close();
  });

  test("the code step of a sign-in shows the long email without breaking the Arabic", async ({ browser }) => {
    // the admin enrols through the product (its own API), then signs in in the browser
    const begun = await (await admin.post("/api/auth/mfa/enrol")).json();
    const secret = base32Decode(begun.secret);
    expect((await admin.post("/api/auth/mfa/activate", { data: { code: totpAt(secret, currentTotpStep()) } })).ok()).toBeTruthy();
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
    const { page, close } = await open(browser, null, "/login");
    await page.locator("#email").fill(ADMIN);
    await page.locator("#password").fill(PASSWORD);
    await page.locator("#password").press("Enter");
    await expect(page.getByTestId("mfa-code-step")).toBeVisible();
    await valueOnly(page.getByTestId("mfa-code-step").getByText(ADMIN, { exact: true }), null, "the email on the code step");
    await fits(page, "the code step");
    await close();
  });

  test("Security Settings, with a change held", async ({ browser }) => {
    const { page, close } = await open(browser, admin2, "/security/settings");
    await expect(page.getByRole("heading", { level: 1, name: "إعدادات الأمان" })).toBeVisible();
    await expect(page.getByTestId("security-settings-pending")).toBeVisible();
    await fits(page, "Security Settings");
    await close();
  });

  test("the security trail on the Users page: the actor's 70-character email, the Arabic beside it intact", async ({ browser }) => {
    const { page, close } = await open(browser, admin2, "/users");
    const event = page.getByTestId("security-events").locator('[data-action="session.revoked_all"]').first();
    await expect(event).toBeVisible();
    const actor = event.getByText(ADMIN, { exact: true });
    await valueOnly(actor, actor.locator(".."), "the actor's email on a security event");
    await expect(actor.locator("..")).toContainText("بواسطة");
    await fits(page, "Users (security trail)");
    await close();
  });

  test("the operator panel: sessions (a full IPv6), the reset card, the platform's limits", async ({ browser }) => {
    const { page, close } = await open(browser, op, "/operator");
    const sessions = page.getByTestId("operator-sessions");
    await sessions.scrollIntoViewIfNeeded();
    const ip = sessions.getByText(IPV6, { exact: true }).first();
    await valueOnly(ip, null, "operator sign-in IP");
    await expect(page.getByTestId("operator-mfa-reset")).toBeVisible();
    await expect(page.getByTestId("platform-security")).toBeVisible();
    await fits(page, "the operator panel");
    await close();
  });
});
