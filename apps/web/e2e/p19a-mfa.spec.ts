import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";
import { base32Decode, currentTotpStep, totpAt } from "../../api/src/lib/totp";

/**
 * 🔴 Phase 19A slice 2 (19.1–19.3) — two-step verification, CLICKED, in Arabic at 390 px: set-up from the Security
 * page (the QR and key, one code, the recovery codes once), then a real sign-in that stops at the code step — a wrong
 * code refused in Arabic, the right one let in — a recovery code in its place, and the operator's assisted reset.
 * The suite's server runs with enforcement `optional` (its fixtures sign in as admins without a phone), so the forced
 * enrolment screen is not reachable here; the server side of it is held by tests/phase19a-mfa.test.ts.
 * Its OWN tenant and operator, removed afterwards.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-p19m-${STAMP}`;
const ADMIN = `e2e-p19m-admin-${STAMP}@smoke.local`;
const OPERATOR = `e2e-p19m-op-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let api: APIRequestContext;
let op: APIRequestContext;
let orgId = "";
let secret: Buffer;
let recoveryCodes: string[] = [];
let usedSteps = 0;
/** A code for a step this spec has not used yet: now, then one step on (inside the accepted drift). */
const nextCode = () => totpAt(secret, currentTotpStep() + usedSteps++);

async function removeTenant() {
  const users = `(SELECT id FROM users WHERE email IN ('${ADMIN}', '${OPERATOR}'))`;
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
  await db.query(`DELETE FROM users WHERE email IN ($1, $2)`, [ADMIN, OPERATOR]);
  await db.query("COMMIT");
}

/** FIXTURE: forget the last accepted step, so the spec can sign in again inside the same 30 seconds (replica mode only). */
async function forgetLastStep() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  await db.query(`UPDATE user_mfa_factors SET last_used_step = NULL WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [ADMIN]);
  await db.query("COMMIT");
  usedSteps = 0;
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E P19M Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E P19M Co','1010404040','300000000000003',1,'gregorian')`, [orgId]);
  const adminId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E P19M Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, adminId]);
  const opId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E P19M Operator',$2,'viewer',true) RETURNING id`, [OPERATOR, hash])).rows[0].id;
  await db.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [opId]);
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  op = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await op.post("/api/auth/login", { data: { email: OPERATOR, password: PASSWORD } })).ok()).toBeTruthy();
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%' OR key LIKE 'mfa%'`);
});

test.afterAll(async () => {
  await api?.dispose();
  await op?.dispose();
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
const fits = (page: Page) => fitsAtPhoneWidth(page);
async function signInWithPassword(page: Page) {
  await page.locator("#email").fill(ADMIN);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#password").press("Enter");
}

test.describe.serial("Phase 19A — two-step verification", () => {
  test("🔴 set-up from the Security page: the QR and the key, one code, the recovery codes once; then it reads On", async ({ browser }) => {
    const { page, close } = await open(browser, api, "/security/two-step");
    await expect(page.getByRole("heading", { level: 1, name: "التحقق بخطوتين" })).toBeVisible();
    await expect(page.getByTestId("two-step-state")).toHaveText("غير مفعَّل");
    await page.getByTestId("mfa-enrol-begin").click();
    await expect(page.getByTestId("mfa-qr")).toBeVisible();
    const shown = (await page.getByTestId("mfa-secret").innerText()).replace(/\s/g, "");
    expect(shown).toMatch(/^[A-Z2-7]{32}$/);
    secret = base32Decode(shown);
    await fits(page);
    await page.getByTestId("mfa-activate-code").fill("000000" === totpAt(secret, currentTotpStep()) ? "111111" : "000000");
    await page.getByTestId("mfa-activate").click();
    await expect(page.getByTestId("mfa-error")).toContainText("الرمز غير صحيح");
    await page.getByTestId("mfa-activate-code").fill(nextCode());
    await page.getByTestId("mfa-activate").click();
    await expect(page.getByTestId("mfa-recovery-code")).toHaveCount(10);
    recoveryCodes = await page.getByTestId("mfa-recovery-code").allInnerTexts();
    await fits(page);
    await expect(page.getByTestId("mfa-enrol-done")).toBeDisabled();
    await page.getByTestId("mfa-codes-saved").check();
    await page.getByTestId("mfa-enrol-done").click();
    await expect(page.getByTestId("two-step-state")).toHaveText("مفعَّل");
    await expect(page.getByTestId("two-step-codes-left")).toContainText("10");
    // the secret is never shown again
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("mfa-secret")).toHaveCount(0);
    await close();
  });

  test("🔴 a sign-in stops at the code step: nothing else opens, a wrong code is refused in Arabic, the right one lets in", async ({ browser }) => {
    const { page, close } = await open(browser, null, "/login");
    await signInWithPassword(page);
    await expect(page.getByTestId("mfa-code-step")).toBeVisible();
    await expect(page.getByTestId("mfa-code-step")).toContainText("قُبلت كلمة مرورك");
    await fits(page);
    // the app is not behind it: a direct visit lands on the same step, and the API refuses
    await page.goto("/invoices", { waitUntil: "networkidle" });
    await expect(page.getByTestId("mfa-code-step")).toBeVisible();
    expect((await page.request.get("/api/invoices")).status()).toBe(403);
    await page.getByTestId("mfa-code").fill("000000" === totpAt(secret, currentTotpStep() + 1) ? "111111" : "000000");
    await page.getByTestId("mfa-submit").click();
    await expect(page.getByTestId("mfa-error")).toContainText("الرمز غير صحيح");
    await page.getByTestId("mfa-code").fill(nextCode());
    await page.getByTestId("mfa-submit").click();
    await expect(page.getByTestId("mfa-code-step")).toHaveCount(0);
    expect((await page.request.get("/api/invoices")).status()).toBe(200);
    await close();
  });

  test("🔴 a recovery code works once in place of the code", async ({ browser }) => {
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%' OR key LIKE 'mfa%'`);
    const { page, close } = await open(browser, null, "/login");
    await signInWithPassword(page);
    await expect(page.getByTestId("mfa-code-step")).toBeVisible();
    await page.getByTestId("mfa-toggle-recovery").click();
    await page.getByTestId("mfa-code").fill(recoveryCodes[0]!);
    await page.getByTestId("mfa-submit").click();
    await expect(page.getByTestId("mfa-code-step")).toHaveCount(0);
    await page.goto("/security/two-step", { waitUntil: "networkidle" });
    await expect(page.getByTestId("two-step-codes-left")).toContainText("9");
    await close();
    // the same code again: refused
    const again = await open(browser, null, "/login");
    await signInWithPassword(again.page);
    await again.page.getByTestId("mfa-toggle-recovery").click();
    await again.page.getByTestId("mfa-code").fill(recoveryCodes[0]!);
    await again.page.getByTestId("mfa-submit").click();
    await expect(again.page.getByTestId("mfa-error")).toContainText("رمز الاسترداد غير صحيح");
    await again.close();
  });

  test("🔴 the operator's assisted reset: refused without the identity check, then done; the person is told at their next sign-in", async ({ browser }) => {
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%' OR key LIKE 'mfa%'`);
    await forgetLastStep();
    const { page, close } = await open(browser, op, "/operator");
    const card = page.getByTestId("operator-mfa-reset");
    await card.scrollIntoViewIfNeeded();
    await card.getByTestId("mfa-reset-email").fill(ADMIN);
    await card.getByTestId("mfa-reset-basis").fill("مكالمة مرئية ومطابقة السجل التجاري والهوية الوطنية");
    await expect(card.getByTestId("mfa-reset-submit"), "not offered until the identity check is confirmed").toBeDisabled();
    await card.getByTestId("mfa-reset-verified").check();
    await card.getByTestId("mfa-reset-submit").click();
    await expect(card.getByTestId("mfa-reset-result")).toContainText("تمت إعادة التعيين");
    await expect(card.getByTestId("mfa-reset-result")).toContainText("سيراه الشخص عند دخوله التالي");
    await fits(page);
    await close();
    expect((await api.get("/api/auth/me")).status(), "the account's sessions ended").toBe(401);
    // the next sign-in: no factor any more (the suite's server does not force enrolment), and the page says what happened
    const next = await open(browser, null, "/login");
    await signInWithPassword(next.page);
    await expect(next.page, "signed in: off the login page").not.toHaveURL(/\/login/);
    await expect(next.page.getByTestId("mfa-code-step")).toHaveCount(0);
    await next.page.goto("/security/two-step", { waitUntil: "networkidle" });
    await expect(next.page.getByTestId("two-step-state")).toHaveText("غير مفعَّل");
    await expect(next.page.getByTestId("two-step-last-reset")).toContainText("أعادت المنصة تعيين التحقق بخطوتين");
    await next.close();
  });
});
