import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 Phase 19A follow-up (owner, 2026-11-20) — who resets a second factor, CLICKED, in Arabic at 390 px:
 *   - an admin resets a member's two-step verification from the Users page: the member's factor is gone and their
 *     session ends;
 *   - the admin's own row offers the same control, and the server's refusal is shown in Arabic (explain, never hide);
 *   - the operator's card shows the platform's refusal in Arabic while the organization has an admin who can do it.
 * Its OWN tenant and operator, removed afterwards. Factors are planted as rows (a reset never opens the secret).
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-p19r-${STAMP}`;
const ADMIN = `e2e-p19r-admin-${STAMP}@smoke.local`;
const MEMBER = `e2e-p19r-member-${STAMP}@smoke.local`;
const MEMBER2 = `e2e-p19r-member2-${STAMP}@smoke.local`;
const OPERATOR = `e2e-p19r-op-${STAMP}@smoke.local`;
const EMAILS = [ADMIN, MEMBER, MEMBER2, OPERATOR];
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let admin: APIRequestContext;
let member: APIRequestContext;
let op: APIRequestContext;
let orgId = "";
const ids: Record<string, number> = {};

async function removeTenant() {
  const list = EMAILS.map((e) => `'${e}'`).join(", ");
  const users = `(SELECT id FROM users WHERE email IN (${list}))`;
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
  await db.query(`DELETE FROM users WHERE email IN (${list})`);
  await db.query("COMMIT");
}

/** FIXTURE: an active factor and ten recovery codes as rows. */
async function plantFactor(userId: number) {
  await db.query(
    `INSERT INTO user_mfa_factors (user_id, state, kms_provider, kms_key_id, wrapped_data_key, encrypted_secret, secret_iv, secret_auth_tag, activated_at)
     VALUES ($1, 'active', 'local-dev', 'fixture', '\\x01', '\\x02', '\\x03', '\\x04', now())`, [userId]);
  await db.query(`INSERT INTO user_mfa_recovery_codes (user_id, code_hash) SELECT $1, 'fixture-' || g FROM generate_series(1, 10) g`, [userId]);
}
const factorRows = async (userId: number) => (await db.query(`SELECT count(*)::int AS n FROM user_mfa_factors WHERE user_id = $1`, [userId])).rows[0].n as number;

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E P19R Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E P19R Co','1010404040','300000000000003',1,'gregorian')`, [orgId]);
  const mk = async (email: string, name: string) =>
    (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id as number;
  ids.admin = await mk(ADMIN, "E2E P19R Admin");
  ids.member = await mk(MEMBER, "E2E P19R Member");
  ids.member2 = await mk(MEMBER2, "E2E P19R Member Two");
  ids.op = await mk(OPERATOR, "E2E P19R Operator");
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active'), ($1,$3,'bookkeeper','active'), ($1,$4,'bookkeeper','active')`, [orgId, ids.admin, ids.member, ids.member2]);
  await db.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [ids.op]);
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%' OR key LIKE 'mfa%' OR key LIKE 'user-admin%'`);
  admin = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await admin.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await admin.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  op = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await op.post("/api/auth/login", { data: { email: OPERATOR, password: PASSWORD } })).ok()).toBeTruthy();
  // the members hold factors from here on: a member's session signed in now owes its code step, and still exists
  await plantFactor(ids.member!);
  await plantFactor(ids.member2!);
  member = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await member.post("/api/auth/login", { data: { email: MEMBER, password: PASSWORD } })).ok()).toBeTruthy();
});

test.afterAll(async () => {
  await admin?.dispose();
  await member?.dispose();
  await op?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function open(browser: Browser, state: APIRequestContext, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await state.storageState(), viewport: PHONE });
  await ctx.addInitScript(() => { try { localStorage.setItem("ksa_lang", "ar"); } catch { /* the default language */ } });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}
/** Nothing clipped sideways at 390 px: the document, the app's content area, an open dialog (e2e/phoneFit.ts). */
const fits = (page: Page) => fitsAtPhoneWidth(page);

test.describe.serial("Phase 19A follow-up — who resets a second factor", () => {
  test("🔴 an admin resets a member's two-step verification from the Users page; the factor goes and the member's session ends", async ({ browser }) => {
    expect((await member.get("/api/auth/me")).status(), "anti-vacuity: the member's session exists before the reset").toBe(200);
    expect(await factorRows(ids.member!)).toBe(1);
    const { page, close } = await open(browser, admin, "/users");
    const control = page.getByTestId(`user-mfa-reset-${ids.member}`);
    await control.scrollIntoViewIfNeeded();
    await fits(page);
    await control.click();
    const dialog = page.getByTestId("user-mfa-reset-dialog");
    await expect(dialog).toContainText("لمن فقد تطبيق المصادقة ورموز الاسترداد");
    await fits(page);
    await dialog.getByTestId("user-mfa-reset-confirm").click();
    await expect(dialog.getByTestId("user-mfa-reset-result")).toContainText("تمت إعادة التعيين");
    await expect(dialog.getByTestId("user-mfa-reset-result")).toContainText("سيراه الشخص عند دخوله التالي");
    await fits(page);
    await close();
    expect(await factorRows(ids.member!), "the factor is removed").toBe(0);
    expect((await member.get("/api/auth/me")).status(), "the member's session ended").toBe(401);
  });

  test("🔴 the admin's own row offers the control, and the refusal is explained in Arabic", async ({ browser }) => {
    const { page, close } = await open(browser, admin, "/users");
    const control = page.getByTestId(`user-mfa-reset-${ids.admin}`);
    await control.scrollIntoViewIfNeeded();
    await control.click();
    const dialog = page.getByTestId("user-mfa-reset-dialog");
    await dialog.getByTestId("user-mfa-reset-confirm").click();
    await expect(dialog.getByTestId("user-mfa-reset-error")).toContainText("لا يمكنك إعادة تعيين التحقق بخطوتين لحسابك");
    await fits(page);
    await close();
  });

  test("🔴 the operator is refused by name, in Arabic, while the organization has an admin who can reset", async ({ browser }) => {
    const { page, close } = await open(browser, op, "/operator");
    const card = page.getByTestId("operator-mfa-reset");
    await card.scrollIntoViewIfNeeded();
    await expect(card).toContainText("فقط إذا لم يستطع ذلك أي مسؤول في منشأة الشخص");
    await card.getByTestId("mfa-reset-email").fill(MEMBER2);
    await card.getByTestId("mfa-reset-basis").fill("مكالمة مرئية ومطابقة الهوية الوطنية");
    await card.getByTestId("mfa-reset-verified").check();
    await card.getByTestId("mfa-reset-submit").click();
    await expect(card.getByTestId("mfa-reset-error")).toContainText("صفحة المستخدمين");
    await fits(page);
    await close();
    expect(await factorRows(ids.member2!), "nothing changed").toBe(1);
  });
});
