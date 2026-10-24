import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "./fixtures";

/**
 * 🔴 G03 (owner D-4, 2026-10-20) — the last-admin refusal, walked on the Users
 * screen, in Arabic and in English.
 *
 * The API suite proves the rule (`g03-last-admin-guard.test.ts`): no act on any
 * path leaves an organisation without an admin who can sign in; 409
 * `last_admin_required`. The Users screen never offers an admin their own row,
 * so the screen meets the refusal only when two admins act AT THE SAME MOMENT:
 * each act is allowed alone, together they would leave none. This spec FORCES
 * that moment — a holder locks the organisation's admin memberships, the other
 * admin's change (sent through the API) queues first, the click queues second,
 * then the holder commits — and shows what the clicking admin is told: what
 * happened and the next step, in their language, keyed on the CODE. Nothing
 * the click asked for is written.
 *
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-g03-${STAMP}`;
const ALPHA = `e2e-g03-alpha-${STAMP}@smoke.local`;
const BETA = `e2e-g03-beta-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let alphaApi: APIRequestContext;
let betaApi: APIRequestContext;
let alphaState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let orgId = "";
let alphaId = 0;
let betaId = 0;

const people = async () =>
  (await db.query(
    `SELECT u.email, m.role, m.status, u.is_active FROM organization_memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 ORDER BY u.email`,
    [orgId],
  )).rows;
const usableAdmins = async () =>
  Number((await db.query(
    `SELECT count(*)::int AS n FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.role = 'admin' AND m.status = 'active' AND u.is_active`,
    [orgId],
  )).rows[0].n);

async function setLang(page: Page, lang: "en" | "ar") {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}

/**
 * Hold the organisation's admin memberships; send `first`, see it wait; send
 * `second`, see it wait too; then release, so they run in that order. Waiters
 * are counted only in the holder's own wait tree.
 */
async function raced(first: () => Promise<unknown>, second: () => Promise<unknown>) {
  const { Client } = await import("pg");
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  try {
    await holder.query("BEGIN");
    const pid = Number((await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
    await holder.query(`SELECT id FROM organization_memberships WHERE organization_id = $1 AND role = 'admin' ORDER BY id FOR UPDATE`, [orgId]);
    const waiters = async () => Number((await db.query(
      `WITH RECURSIVE tree(pid) AS (SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN tree t ON t.pid = ANY (pg_blocking_pids(a.pid)))
       SELECT (count(*) - 1)::int AS n FROM tree`, [pid],
    )).rows[0].n);
    const a = first();
    await expect.poll(waiters, { message: "the other admin's change queued on the lock" }).toBeGreaterThanOrEqual(1);
    const b = second();
    await expect.poll(waiters, { message: "the click queued behind it" }).toBeGreaterThanOrEqual(2);
    await holder.query("COMMIT");
    return await Promise.all([a, b]);
  } finally {
    await holder.end();
  }
}

/** BETA, through the API, makes ALPHA a bookkeeper — allowed alone (BETA remains an admin). */
const betaDemotesAlpha = () => betaApi.post(`/api/orgs/${orgId}/members`, { data: { userId: alphaId, role: "bookkeeper" } });

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email IN ('${ALPHA}','${BETA}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2)`, [ALPHA, BETA]);
  await db.query("COMMIT");
}

/** Both are admins again, both accounts active — the state each test starts from. */
async function twoAdmins() {
  await db.query(`UPDATE organization_memberships SET role = 'admin', status = 'active' WHERE organization_id = $1`, [orgId]);
  await db.query(`UPDATE users SET is_active = true WHERE id = ANY($1::int[])`, [[alphaId, betaId]]);
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E G03 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E G03 Co',1,'gregorian')`, [orgId]);
  alphaId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E G03 Alpha',$2,'viewer',true) RETURNING id`, [ALPHA, hash])).rows[0].id;
  betaId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E G03 Beta',$2,'viewer',true) RETURNING id`, [BETA, hash])).rows[0].id;
  for (const id of [alphaId, betaId]) await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, id]);

  alphaApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  betaApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  for (const [ctx, email] of [[alphaApi, ALPHA], [betaApi, BETA]] as const) {
    expect((await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
    expect((await ctx.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  alphaState = await alphaApi.storageState();
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await alphaApi?.dispose();
  await betaApi?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

test.describe.serial("G03 — the Users screen explains the last-admin refusal", () => {
  test("🔴 AR phone: Deactivate meets the other admin's demotion — the refusal is told in Arabic with the next step, and the account stays active", async ({ browser }) => {
    await twoAdmins();
    const ctx = await browser.newContext({ storageState: alphaState, viewport: PHONE });
    const page = await ctx.newPage();
    await page.goto("/users", { waitUntil: "networkidle" });
    await setLang(page, "ar");
    const row = page.locator("div.flex.items-center", { hasText: BETA }).first();
    await expect(row.getByRole("button", { name: "تعطيل" })).toBeVisible();

    const [beta] = (await raced(betaDemotesAlpha, () => row.getByRole("button", { name: "تعطيل" }).click())) as [{ status: () => number }, unknown];
    expect(beta.status(), "the other admin's change applied").toBe(201);
    await expect(page.getByText("لم يتغيّر شيء — كانت المنظمة ستبقى بلا مسؤول").first()).toBeVisible();
    await expect(page.getByText(/اجعل عضوًا آخر مسؤولًا أولًا/).first()).toBeVisible();
    expect(await people(), "BETA is still an active admin; only BETA's own change was written").toEqual([
      { email: ALPHA, role: "bookkeeper", status: "active", is_active: true },
      { email: BETA, role: "admin", status: "active", is_active: true },
    ]);
    expect(await usableAdmins()).toBe(1);
    await ctx.close();
  });

  test("🔴 EN desktop: a role change meets the other admin's demotion — the refusal is told in English with the next step, and the role stays", async ({ browser }) => {
    await twoAdmins();
    const ctx = await browser.newContext({ storageState: alphaState, viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto("/users", { waitUntil: "networkidle" });
    await setLang(page, "en");
    const row = page.locator("div.flex.items-center", { hasText: BETA }).first();
    await expect(row.locator("select")).toHaveValue("admin");

    const [beta] = (await raced(betaDemotesAlpha, () => row.locator("select").selectOption("viewer"))) as [{ status: () => number }, unknown];
    expect(beta.status(), "the other admin's change applied").toBe(201);
    await expect(page.getByText("Not changed — the organization would have no admin").first()).toBeVisible();
    await expect(page.getByText(/Make another member an admin first/).first()).toBeVisible();
    expect(await people()).toEqual([
      { email: ALPHA, role: "bookkeeper", status: "active", is_active: true },
      { email: BETA, role: "admin", status: "active", is_active: true },
    ]);
    expect(await usableAdmins()).toBe(1);
    await ctx.close();
  });
});
