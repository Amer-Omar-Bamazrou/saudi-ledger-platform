import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { businessToday } from "@workspace/shared";

/**
 * 🔴 The 2026-11-08 re-walk's three findings (the owner, 2026-11-09: all three in one follow-up to #315), CLICKED in
 * Arabic at 390 px:
 *  1. The run screen's posted line read "100.00 927# · ر.س": the amount and the entry number shared one left-to-right
 *     span with an Arabic currency mark, so the entry number was pulled into right-to-left order beside the amount.
 *     They must be two elements, side by side, never interleaved.
 *  2. The accruals page at 390 px: its schedules table scrolled sideways inside its card, so a row's Activate started
 *     off-screen, and its status printed in English ("draft", "active").
 *  3. The customers subtitle read "4 عميل نشط" (and "1 active customers" in English): the count must agree with the
 *     number, as W-19 made the bank-account count do.
 * 🔴 Its OWN tenant, created and removed here (a run posts for every schedule of the company).
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-walkfix-${STAMP}`;
const ADMIN = `e2e-walkfix-admin-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const MONTH = businessToday().slice(0, 7);

let db: Db;
let api: APIRequestContext;
let orgId = "";
let scheduleId = 0;

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
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Walk Fix Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Walk Fix Co','1010707070','300000000000003',1,'gregorian')`, [orgId]);
  const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E Walk Fix Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, id]);
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
  // One prepayment, left as a DRAFT: the page shows its status and its Activate control.
  const account = async (code: string) => (await db.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
  scheduleId = (await ok<{ id: number }>(api.post("/api/recognition-schedules", { data: {
    kind: "prepayment", reference: "WF-PRE", description: "Walk fix prepayment", totalAmount: 300, periods: 3, startPeriod: MONTH,
    expenseAccountId: await account("RENT_UTILITIES"), balanceAccountId: await account("PREPAID_EXPENSES"),
  } }), "schedule")).id;
  // One customer, so the count reads "one".
  await ok(api.post("/api/customers", { data: { name: `Walk Fix Customer 1 ${STAMP}`, nameAr: `عميل الإصلاح 1 ${STAMP}` } }), "customer 1");
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

const box = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  expect(b, `${testId} is laid out`).not.toBeNull();
  return b!;
};

test.describe("the re-walk's three findings (Arabic, 390 px)", () => {
  test("🔴 2: the accruals schedules are cards at 390 px — the row's Activate is on screen — and the status is in Arabic", async ({ browser }) => {
    const { page, close } = await open(browser, "ar", "/recognition-schedules");
    const status = page.getByTestId("status-WF-PRE");
    await expect(status, "the status in the reader's language").toHaveText("مسودة");
    const activate = await box(page, "activate-WF-PRE");
    expect(activate.x, "Activate starts on screen").toBeGreaterThanOrEqual(0);
    expect(activate.x + activate.width, "and ends on screen").toBeLessThanOrEqual(PHONE.width);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w, "no sideways page scroll").toBeLessThanOrEqual(PHONE.width + 1);
    // Activate by clicking; the status follows the language.
    await page.getByTestId("activate-WF-PRE").click();
    await expect(page.getByTestId("status-WF-PRE")).toHaveText("نشط");
    await close();
  });

  test("🔴 1: the run's posted line keeps the amount and the entry number apart", async ({ browser }) => {
    // The schedule must be active for the run to post (the previous test activates it by clicking; this one does not rely on it).
    const s = await ok<{ status: string }>(api.get(`/api/recognition-schedules/${scheduleId}`), "schedule");
    if (s.status === "draft") await ok(api.post(`/api/recognition-schedules/${scheduleId}/activate`, { data: {} }), "activate");
    const { page, close } = await open(browser, "ar", "/recognition-schedules");
    await page.getByTestId("recognition-run-open").click();
    const dlg = page.getByTestId("recognition-run-dialog");
    await dlg.getByTestId("recognition-run-period").fill(MONTH);
    await dlg.getByTestId("recognition-run-continue").click();
    await dlg.getByTestId("recognition-run-confirm").click();
    const row = dlg.getByTestId("recognition-run-posted-WF-PRE");
    await expect(row).toBeVisible();
    const amount = row.getByTestId("recognition-run-posted-WF-PRE-amount");
    const entry = row.getByTestId("recognition-run-posted-WF-PRE-entry");
    await expect(amount, "the amount on its own").toHaveText(/^100\.00/);
    await expect(entry, "the entry number on its own, labelled").toHaveText(/^قيد #\d+$/);
    const a = await box(page, "recognition-run-posted-WF-PRE-amount");
    const e = await box(page, "recognition-run-posted-WF-PRE-entry");
    const apart = a.x + a.width <= e.x || e.x + e.width <= a.x;
    expect(apart, "the two never interleave on the line").toBe(true);
    await close();
  });

  test("🔴 3: the customers count agrees with the number, in Arabic and in English", async ({ browser }) => {
    let { page, close } = await open(browser, "ar", "/customers");
    const subtitle = page.getByRole("heading", { level: 1 }).locator("xpath=following-sibling::p[1]");
    await expect(subtitle).toContainText("عميل نشط واحد");
    await close();
    ({ page, close } = await open(browser, "en", "/customers"));
    const sub1en = page.getByRole("heading", { level: 1 }).locator("xpath=following-sibling::p[1]");
    await expect(sub1en).toContainText("1 active customer");
    await expect(sub1en).not.toContainText("1 active customers");
    await close();
    for (const n of [2, 3, 4]) await ok(api.post("/api/customers", { data: { name: `Walk Fix Customer ${n} ${STAMP}`, nameAr: `عميل الإصلاح ${n} ${STAMP}` } }), `customer ${n}`);
    ({ page, close } = await open(browser, "ar", "/customers"));
    const sub4 = page.getByRole("heading", { level: 1 }).locator("xpath=following-sibling::p[1]");
    await expect(sub4).toContainText("4 عملاء نشطين");
    await expect(sub4).not.toContainText("4 عميل نشط");
    await close();
    ({ page, close } = await open(browser, "en", "/customers"));
    await expect(page.getByRole("heading", { level: 1 }).locator("xpath=following-sibling::p[1]")).toContainText("4 active customers");
    await close();
  });
});
