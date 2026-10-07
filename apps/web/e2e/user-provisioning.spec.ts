import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";

/**
 * G04 zero-membership (2026-10-07) — creating a team member through the Users
 * screen, walked in a browser.
 *
 * The API suite proves the rule (`g04-zero-membership.test.ts`): an account is
 * born WITH its first membership, in one transaction, in an organization the
 * caller administers. What only a browser can show is the CLIENT'S request:
 * the page used to send TWO calls — create the account, then attach it — and
 * between them the account had no membership, which is the window another
 * organization's admin used to take it over. "A server test cannot see the
 * client's request construction" (CLAUDE.md §3), so this spec watches the wire:
 * ONE `/auth/register` carrying the active organization, and no attach.
 *
 * And the refusal is EXPLAINED, not hidden: setting a role for someone who is
 * not a member of this organization shows the server's sentence, which names
 * the next step (an invitation), and writes nothing.
 *
 * 🔴 Its OWN tenants, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG_A = `e2e-g04-a-${STAMP}`;
const SLUG_B = `e2e-g04-b-${STAMP}`;
const ADMIN = `e2e-g04-admin-${STAMP}@smoke.local`;
const OUTSIDER = `e2e-g04-outsider-${STAMP}@smoke.local`;
const HIRE = `e2e-g04-hire-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let api: APIRequestContext;
let state: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let orgA = "";
let orgB = "";

const memberships = async (email: string) =>
  (await db.query(
    `SELECT m.organization_id AS org, m.role, m.status FROM organization_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 ORDER BY 1`,
    [email],
  )).rows;

async function setLang(page: Page, lang: "en" | "ar") {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}

async function removeTenants() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug IN ('${SLUG_A}','${SLUG_B}'))`;
  const users = `(SELECT id FROM users WHERE email IN ('${ADMIN}','${OUTSIDER}','${HIRE}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug IN ($1,$2)`, [SLUG_A, SLUG_B]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2,$3)`, [ADMIN, OUTSIDER, HIRE]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  // The admin administers BOTH organizations; the outsider belongs to B only —
  // so the Users screen of org A lists the outsider with no membership in A.
  orgA = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E G04 Org A', $1, 'approved') RETURNING id`, [SLUG_A])).rows[0].id;
  orgB = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E G04 Org B', $1, 'approved') RETURNING id`, [SLUG_B])).rows[0].id;
  for (const o of [orgA, orgB]) await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E G04 Co',1,'gregorian')`, [o]);
  const adminId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E G04 Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  for (const o of [orgA, orgB]) await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [o, adminId]);
  const outsiderId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E G04 Outsider',$2,'viewer',true) RETURNING id`, [OUTSIDER, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'bookkeeper','active')`, [orgB, outsiderId]);

  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgA } })).ok(), "the session administers org A").toBeTruthy();
  state = await api.storageState();
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await api?.dispose();
  if (db) {
    await removeTenants();
    await db.end();
  }
});

test.describe.serial("G04 — a team member is created WITH their membership, through the Users screen", () => {
  test("🔴 AR phone: Add user sends ONE request carrying the organization, and the account is born a member", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: state, viewport: PHONE });
    const page = await ctx.newPage();
    const calls: { url: string; body: any }[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/api\/(auth\/register|orgs\/[^/]+\/members)$/.test(new URL(r.url()).pathname)) {
        calls.push({ url: new URL(r.url()).pathname, body: r.postDataJSON() });
      }
    });
    await page.goto("/users", { waitUntil: "networkidle" });
    await setLang(page, "ar");

    await page.getByRole("button", { name: "إضافة مستخدم" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("input").nth(0).fill("موظف جديد");
    await dialog.locator('input[type="email"]').fill(HIRE);
    await dialog.locator('input[type="password"]').fill("Initial-Pw-123!");
    await dialog.locator("select").selectOption("accountant");
    await dialog.getByRole("button", { name: "إنشاء مستخدم" }).click();
    await expect(dialog).toBeHidden();

    // The wire: exactly one register, naming the active organization; no attach.
    expect(calls.map((c) => c.url)).toEqual(["/api/auth/register"]);
    expect(calls[0]!.body).toMatchObject({ email: HIRE, role: "accountant", organizationId: orgA });
    // The database: born with exactly its membership.
    expect(await memberships(HIRE)).toEqual([{ org: orgA, role: "accountant", status: "active" }]);
    // The screen: the new person is listed with the governing role.
    await expect(page.locator("div", { hasText: HIRE }).getByText("ACCOUNTANT").first()).toBeVisible();
    await ctx.close();
  });

  test("🔴 EN desktop: setting a role for someone who is NOT a member explains the invitation and writes nothing", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: state, viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto("/users", { waitUntil: "networkidle" });
    await setLang(page, "en");
    const row = page.locator("div.flex.items-center", { hasText: OUTSIDER }).first();
    await expect(row.getByText("NO MEMBERSHIP")).toBeVisible();
    await row.locator("select").selectOption("viewer");
    await expect(page.getByText(/send them an invitation/i).first()).toBeVisible();
    expect(await memberships(OUTSIDER), "still a member of org B only").toEqual([{ org: orgB, role: "bookkeeper", status: "active" }]);
    await ctx.close();
  });
});
