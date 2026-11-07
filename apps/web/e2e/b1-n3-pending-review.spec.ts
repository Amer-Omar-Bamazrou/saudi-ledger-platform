import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from "./fixtures";

/**
 * 🔴 Carry-over Batch 1, N-3 (the owner, 2026-11-07; the re-walk's finding, `2026-11-05-rewalk/rewalk-record.md`):
 * a user of a company in `pending_review` must never see the hub or the full menu. They are routed to the review
 * screen at sign-in and on every load, before the hub's first paint, and the review screen stops telling them to
 * sign in again.
 *
 * "Never painted" is measured, not inferred: a MutationObserver installed before any page script records whether the
 * hub's shell (its sidebar or its phone menu button) was ever attached to the document. The approved control proves
 * the observer sees the hub when it is there, so its "never" for the pending user is not a blind probe.
 * 🔴 Its OWN tenants, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-n3-${STAMP}`;
const PENDING_SLUG = `e2e-n3-pending-${STAMP}`;
const ADMIN = `e2e-n3-admin-${STAMP}@smoke.local`;
const PENDING = `e2e-n3-pending-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const HUB = 'aside, [data-testid="nav-hamburger"], [data-testid="nav-drawer"]';

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E N3 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  const pendingOrg = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E N3 Pending', $1, 'pending_review') RETURNING id`, [PENDING_SLUG])).rows[0].id;
  for (const id of [orgId, pendingOrg]) await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E N3 Co',1,'gregorian')`, [id]);
  for (const [email, name, org] of [[ADMIN, "E2E N3 Admin", orgId], [PENDING, "E2E N3 Pending", pendingOrg]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [org, id]);
  }
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
  adminApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  pendingApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await adminApi.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await pendingApi.post("/api/auth/login", { data: { email: PENDING, password: PASSWORD } })).ok()).toBeTruthy();
});

test.afterAll(async () => {
  await adminApi?.dispose();
  await pendingApi?.dispose();
  if (db) {
    await removeTenants();
    await db.end();
  }
});

/**
 * A context whose pages record, from before any app script, whether the hub's shell was ever attached.
 * 🔴 The record lives in sessionStorage, not on `window`: the old route to the review screen is a FULL-PAGE redirect
 * after the hub has painted, and a per-document flag starts again at false in the new document, so it cannot see a
 * paint that happened before the reload. (Found by this spec's first red run: its per-page flag passed those loads.)
 */
async function watched(browser: Browser, opts: { lang: "ar" | "en"; phone: boolean; api?: APIRequestContext }): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    storageState: opts.api ? await opts.api.storageState() : undefined,
    viewport: opts.phone ? PHONE : { width: 1280, height: 900 },
  });
  await ctx.addInitScript(({ hub, lang }) => {
    try { localStorage.setItem("ksa_lang", lang); } catch { /* storage refused: the default language */ }
    const check = () => { if (document.querySelector(hub)) sessionStorage.setItem("__n3HubSeen", String(location.pathname)); };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  }, { hub: HUB, lang: opts.lang });
  return ctx;
}

/** Where the hub's shell was seen in this tab, across every document since the context opened; null if never. */
const hubSeen = (page: Page) => page.evaluate(() => sessionStorage.getItem("__n3HubSeen"));

test.describe("N-3: a pending company's user never sees the hub", () => {
  test("control: an approved company's user lands on the hub, and the probe sees it", async ({ browser }) => {
    const ctx = await watched(browser, { lang: "ar", phone: true, api: adminApi });
    const page = await ctx.newPage();
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.locator('[data-testid="nav-hamburger"]')).toBeVisible();
    expect(await hubSeen(page), "the probe can see the hub").not.toBeNull();
    await ctx.close();
  });

  for (const [lang, phone] of [["ar", true], ["en", false]] as const) {
    test(`🔴 signing in through the form (${lang}${phone ? ", 390 px" : ""}) lands on the review screen, and the hub is never painted`, async ({ browser }) => {
      await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
      const ctx = await watched(browser, { lang, phone });
      const page = await ctx.newPage();
      await page.goto("/login", { waitUntil: "networkidle" });
      await page.locator("#email").fill(PENDING);
      await page.locator("#password").fill(PASSWORD);
      await page.locator('form button[type="submit"]').click();
      await page.waitForURL(/\/verification$/);
      await expect(page.getByTestId("verification-pending-steps")).toBeVisible();
      expect(await hubSeen(page), "the hub's shell was attached at some point between sign-in and the review screen").toBeNull();
      await ctx.close();
    });
  }

  for (const path of ["/", "/invoices", "/customers"]) {
    test(`🔴 every load: opening ${path} as the pending user goes to the review screen before the hub paints`, async ({ browser }) => {
      const ctx = await watched(browser, { lang: "ar", phone: true, api: pendingApi });
      const page = await ctx.newPage();
      await page.goto(path, { waitUntil: "networkidle" });
      await page.waitForURL(/\/verification$/);
      await expect(page.getByTestId("verification-pending-steps")).toBeVisible();
      expect(await hubSeen(page), `the hub was painted on ${path}`).toBeNull();
      await page.reload({ waitUntil: "networkidle" });
      await expect(page).toHaveURL(/\/verification$/);
      expect(await hubSeen(page), "and again after a reload").toBeNull();
      await ctx.close();
    });
  }

  for (const [lang, signInAgain, updates] of [
    ["ar", "سجّل الدخول", "تتحدث تلقائيًا"],
    ["en", "Sign in again", "updates by itself"],
  ] as const) {
    test(`🔴 the review screen (${lang}) no longer tells them to sign in again, and says it updates by itself`, async ({ browser }) => {
      const ctx = await watched(browser, { lang, phone: lang === "ar", api: pendingApi });
      const page = await ctx.newPage();
      await page.goto("/verification", { waitUntil: "networkidle" });
      const steps = page.getByTestId("verification-pending-steps");
      await expect(steps).toBeVisible();
      await expect(steps, "no sign-in-again step").not.toContainText(signInAgain);
      await expect(steps, "the screen says it shows the result itself").toContainText(updates);
      await ctx.close();
    });
  }
});
