import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";

/**
 * 🔴 G02 (owner D-4 and DR-07(a), 2026-10-20) — a session ends when what it was
 * issued for ends, walked in a browser, in Arabic and in English.
 *
 * The API suite proves the rule (`g02-session-lifetime.test.ts` and the 4B
 * proof). What only a browser shows is what the PERSON sees: the deactivated
 * colleague's open app goes to the sign-in page on their next step, and the
 * person who changes their password stays signed in where they did it while
 * their other open session is signed out — and the page says so before and
 * after.
 *
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-g02-${STAMP}`;
const ADMIN = `e2e-g02-admin-${STAMP}@smoke.local`;
const COLLEAGUE = `e2e-g02-colleague-${STAMP}@smoke.local`;
const CHANGER = `e2e-g02-changer-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const NEW_PASSWORD = "e2e-g02-new-password-2026";

let db: Db;
const apis: APIRequestContext[] = [];
type State = Awaited<ReturnType<APIRequestContext["storageState"]>>;
let orgId = "";
let colleagueId = 0;
let changerId = 0;

const sessionsOf = async (userId: number) =>
  Number((await db.query(`SELECT count(*)::int AS n FROM user_sessions WHERE (sess ->> 'userId')::int = $1`, [userId])).rows[0].n);

/** A signed-in session for `email`, active in the tenant, as a storage state a browser context can open. */
async function signedIn(email: string): Promise<State> {
  const api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  apis.push(api);
  expect((await api.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  return api.storageState();
}

async function setLang(page: Page, lang: "en" | "ar") {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email IN ('${ADMIN}','${COLLEAGUE}','${CHANGER}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2,$3)`, [ADMIN, COLLEAGUE, CHANGER]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E G02 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E G02 Co',1,'gregorian')`, [orgId]);
  const mk = async (email: string, name: string, role: string) => {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id as number;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    return id;
  };
  await mk(ADMIN, "E2E G02 Admin", "admin");
  colleagueId = await mk(COLLEAGUE, "E2E G02 Colleague", "bookkeeper");
  changerId = await mk(CHANGER, "E2E G02 Changer", "bookkeeper");
});

test.afterAll(async () => {
  for (const api of apis) await api.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

test.describe.serial("G02 — sessions end when what they were issued for ends", () => {
  test("🔴 AR phone: an admin deactivates a colleague on the Users screen — the colleague's open app goes to sign-in on their next step", async ({ browser }) => {
    const adminState = await signedIn(ADMIN);
    const colleagueState = await signedIn(COLLEAGUE);
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);

    const colleague = await browser.newContext({ storageState: colleagueState, viewport: PHONE });
    const cPage = await colleague.newPage();
    await cPage.goto("/invoices", { waitUntil: "networkidle" });
    await setLang(cPage, "ar");
    await expect(cPage).toHaveURL(/\/invoices$/);

    const admin = await browser.newContext({ storageState: adminState, viewport: PHONE });
    const aPage = await admin.newPage();
    await aPage.goto("/users", { waitUntil: "networkidle" });
    await setLang(aPage, "ar");
    const row = aPage.locator("div.flex.items-center", { hasText: COLLEAGUE }).first();
    await row.getByRole("button", { name: "تعطيل" }).click();
    await expect(aPage.getByText("تم تحديث المستخدم").first()).toBeVisible();
    expect(await sessionsOf(colleagueId), "the colleague's sessions are gone").toBe(0);

    await cPage.reload({ waitUntil: "networkidle" });
    await expect(cPage, "the colleague's next step lands on sign-in").toHaveURL(/\/login$/);
    await expect(cPage.locator("html")).toHaveAttribute("dir", "rtl");
    await aPage.goto("/invoices", { waitUntil: "networkidle" });
    await expect(aPage, "the admin's own session is untouched").toHaveURL(/\/invoices$/);
    await colleague.close();
    await admin.close();
  });

  test("🔴 EN desktop: changing one's own password keeps THIS session and signs out the other — the page says so", async ({ browser }) => {
    const here = await signedIn(CHANGER);
    const elsewhere = await signedIn(CHANGER);
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
    expect(await sessionsOf(changerId)).toBe(2);

    const other = await browser.newContext({ storageState: elsewhere, viewport: DESKTOP });
    const oPage = await other.newPage();
    await oPage.goto("/invoices", { waitUntil: "networkidle" });
    await expect(oPage).toHaveURL(/\/invoices$/);

    const ctx = await browser.newContext({ storageState: here, viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto("/change-password", { waitUntil: "networkidle" });
    await setLang(page, "en");
    await expect(page.getByText("You'll stay signed in here. Every other session of this account is signed out.")).toBeVisible();
    await page.locator("#current").fill(PASSWORD);
    await page.locator("#next").fill(NEW_PASSWORD);
    await page.locator("#confirm").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed. Your other sessions are signed out.")).toBeVisible();
    expect(await sessionsOf(changerId), "only this session is left").toBe(1);

    await page.goto("/invoices", { waitUntil: "networkidle" });
    await expect(page, "this session is kept").toHaveURL(/\/invoices$/);
    await oPage.reload({ waitUntil: "networkidle" });
    await expect(oPage, "the other session lands on sign-in").toHaveURL(/\/login$/);
    await other.close();
    await ctx.close();
  });
});
