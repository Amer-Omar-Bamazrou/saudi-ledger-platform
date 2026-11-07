import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * 🔴 Carry-over Batch 1, the app's shell (the owner, 2026-11-07; the walks' findings):
 *  - N-10: the role chip shows the user's real role, their role in the active organization. A bookkeeper and a founder
 *    (an organization admin whose vestigial global role is "viewer") were both shown "مشاهد".
 *  - W-20: menu sections the user opened stay open after navigating: the phone drawer reopened with them collapsed.
 *  - The dialogs' Close button's hidden label is Arabic in Arabic mode.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-shell-${STAMP}`;
const FOUNDER = `e2e-shell-founder-${STAMP}@smoke.local`;
const BOOKKEEPER = `e2e-shell-bookkeeper-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let founderApi: APIRequestContext;
let bookkeeperApi: APIRequestContext;

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email IN ('${FOUNDER}','${BOOKKEEPER}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2)`, [FOUNDER, BOOKKEEPER]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Shell Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Shell Co','1010404040','300000000000003',1,'gregorian')`, [orgId]);
  // Both carry the vestigial global role "viewer", as a self-signup founder does; their ORGANIZATION roles differ.
  for (const [email, name, role] of [[FOUNDER, "E2E Shell Founder", "admin"], [BOOKKEEPER, "E2E Shell Bookkeeper", "bookkeeper"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
  }
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
  founderApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  bookkeeperApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await founderApi.post("/api/auth/login", { data: { email: FOUNDER, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await bookkeeperApi.post("/api/auth/login", { data: { email: BOOKKEEPER, password: PASSWORD } })).ok()).toBeTruthy();
});

test.afterAll(async () => {
  await founderApi?.dispose();
  await bookkeeperApi?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function open(browser: Browser, api: APIRequestContext, lang: "ar" | "en", viewport: { width: number; height: number }, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport });
  await ctx.addInitScript((l) => { try { localStorage.setItem("ksa_lang", l); } catch { /* the default language */ } }, lang);
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  return { page, close: () => ctx.close() };
}

test.describe("the shell: role chip, menu sections, Close label", () => {
  for (const [who, lang, shown] of [
    ["founder", "ar", "مدير"], ["bookkeeper", "ar", "ماسك دفاتر"],
    ["founder", "en", "ADMIN"], ["bookkeeper", "en", "BOOKKEEPER"],
  ] as const) {
    test(`🔴 N-10: the ${who}'s role chip reads "${shown}" (${lang}), not viewer`, async ({ browser }) => {
      const { page, close } = await open(browser, who === "founder" ? founderApi : bookkeeperApi, lang, DESKTOP, "/");
      const sidebar = page.locator("aside").first();
      await expect(sidebar.getByText(shown, { exact: true }), "the real role").toBeVisible();
      await expect(sidebar.getByText(lang === "ar" ? "مشاهد" : "VIEWER", { exact: true }), "not viewer").toHaveCount(0);
      await close();
    });
  }

  test("🔴 W-20: sections opened on the phone menu stay open after navigating", async ({ browser }) => {
    const { page, close } = await open(browser, founderApi, "ar", PHONE, "/");
    await page.getByTestId("nav-hamburger").click();
    const drawer = page.getByTestId("nav-drawer");
    const collapsed = drawer.locator('[data-nav-section][aria-expanded="false"]');
    expect(await collapsed.count(), "there are collapsed sections to open").toBeGreaterThanOrEqual(2);
    const via = await collapsed.nth(0).getAttribute("data-nav-section");
    const kept = await collapsed.nth(1).getAttribute("data-nav-section");
    await drawer.locator(`[data-nav-section="${kept}"]`).click();
    await drawer.locator(`[data-nav-section="${via}"]`).click();
    await expect(drawer.locator(`[data-nav-section="${kept}"]`)).toHaveAttribute("aria-expanded", "true");
    const link = drawer.locator(`[data-nav-section="${via}"]`).locator("xpath=following-sibling::div[1]").locator("a[href]").first();
    const target = await link.getAttribute("href");
    await link.click();
    await page.waitForURL((u) => u.pathname === target?.split("?")[0]);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("nav-hamburger").click();
    await expect(page.getByTestId("nav-drawer").locator(`[data-nav-section="${kept}"]`), "the section the user opened is still open").toHaveAttribute("aria-expanded", "true");
    await close();
  });

  for (const [lang, label, other] of [["ar", "إغلاق", "Close"], ["en", "Close", "إغلاق"]] as const) {
    test(`🔴 the dialog's Close button is labelled "${label}" (${lang})`, async ({ browser }) => {
      const { page, close } = await open(browser, founderApi, lang, lang === "ar" ? PHONE : DESKTOP, "/invoices");
      await page.getByRole("button", { name: lang === "ar" ? "فاتورة جديدة" : "New Invoice" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("span.sr-only").filter({ hasText: label }), "the hidden label in the page's language").toHaveCount(1);
      await expect(dialog.locator("span.sr-only").filter({ hasText: other }), "and not the other language").toHaveCount(0);
      await close();
    });
  }
});
