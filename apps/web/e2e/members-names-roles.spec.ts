import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 ITEM 4 THROUGH THE PAGE (owner, 2026-11-25). Arabic, 390 px. A non-admin opening Users & Roles sees who is in the
 * organization and in which role — and no member's email anywhere on the page, their own included. The admin's page
 * still shows every email. (The API is held by tests/members-list-names-roles.test.ts.) Its OWN tenant.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-members-nr-${STAMP}`;
const USERS = {
  admin: { email: `e2e-mnr-adm-${STAMP}@smoke.local`, name: "منيرة المسؤولة" },
  bookkeeper: { email: `e2e-mnr-keep-${STAMP}@smoke.local`, name: "خالد الدفاتر" },
  viewer: { email: `e2e-mnr-view-${STAMP}@smoke.local`, name: "سارة المطّلعة" },
} as const;
type Role = keyof typeof USERS;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
const api = {} as Record<Role, APIRequestContext>;

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const emails = Object.values(USERS).map((u) => `'${u.email}'`).join(",");
  const users = `(SELECT id FROM users WHERE email IN (${emails}))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN (${emails})`);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Members NR Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Members NR Co','1010707072','319292929292973','1234','King Fahd Road','Al Olaya','Riyadh','12345',1,'gregorian')`, [orgId]);
  for (const role of Object.keys(USERS) as Role[]) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [USERS[role].email, USERS[role].name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    api[role] = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
    const login = await api[role].post("/api/auth/login", { data: { email: USERS[role].email, password: PASSWORD } });
    expect(login.ok(), `login ${role}: ${login.status()}`).toBeTruthy();
    expect((await api[role].post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
});

test.afterAll(async () => {
  for (const a of Object.values(api)) await a?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function pageAs(browser: Browser, role: Role, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api[role].storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

test.describe.serial("item 4 — the member list for every member (Arabic, 390 px)", () => {
  for (const who of ["bookkeeper", "viewer"] as const) {
    test(`🔴 ${who}: Users & Roles lists every member's name and role — and no email, their own included`, async ({ browser }) => {
      const { page, close } = await pageAs(browser, who, "/users");
      await expect(page.getByTestId("members-read-only")).toBeVisible();
      // each member's row: the name, and the role in Arabic (walkLabels.roleName)
      const ROLE_AR: Record<Role, string> = { admin: "مسؤول", bookkeeper: "ماسك دفاتر", viewer: "مشاهد" };
      await expect(page.locator('[data-testid^="member-row-"]')).toHaveCount(3);
      for (const role of Object.keys(USERS) as Role[]) {
        const row = page.locator('[data-testid^="member-row-"]').filter({ hasText: USERS[role].name });
        await expect(row).toContainText(ROLE_AR[role]);
      }
      // no OTHER member's email anywhere on the page; the list itself carries no email at all (the member's own address
      // is theirs — the account menu shows it, and /auth/me serves it)
      const html = await page.content();
      expect((Object.keys(USERS) as Role[]).filter((r) => r !== who && html.includes(USERS[r].email))).toEqual([]);
      const listText = await page.getByTestId("members-read-only").innerText();
      expect(Object.values(USERS).filter((u) => listText.includes(u.email)).map((u) => u.email)).toEqual([]);
      expect(listText).not.toContain("@");
      await fitsAtPhoneWidth(page, `the member list (${who})`);
      await close();
    });
  }

  test("movement: the admin's page still shows every member's email", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "admin", "/users");
    await expect(page.getByTestId("members-read-only")).toHaveCount(0);
    // a VISIBLE match: at 390 px the account menu's copy of the admin's own address is hidden
    for (const u of Object.values(USERS)) await expect(page.locator(`:text("${u.email}"):visible`).first()).toBeVisible();
    await close();
  });
});
