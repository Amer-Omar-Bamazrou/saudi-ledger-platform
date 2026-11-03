import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "./fixtures";

/**
 * 🔴 Phase 18 R-11a — DR-14's control flags (register §11.111), walked: an admin who approves a journal entry they
 * made is flagged, and the flag is where the approvers look — Company settings.
 *
 *  - EN desktop: ALPHA (admin) sees "Control flags" with its true total, the flag naming ALPHA and the entry.
 *  - AR phone: the same section in Arabic, with no sideways scroll.
 *  - The bookkeeper's Company settings shows no such section (the server refuses them the flags; the page offers
 *    nothing it cannot read) — beside the admin's page showing it, so the absence is not an empty page.
 *
 * The API suite proves every writer (`phase18-r11a-dr14-control-flags.test.ts`); this walks the reader.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-r11a-${STAMP}`;
const ALPHA = `e2e-r11a-alpha-${STAMP}@smoke.local`;
const KEEPER = `e2e-r11a-keeper-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const ENTRY = `R11A-E2E-${STAMP}`;

let db: Db;
let alphaApi: APIRequestContext;
let keeperApi: APIRequestContext;
let alphaState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let keeperState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let orgId = "";

async function setLang(page: Page, lang: "en" | "ar") {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}

async function json<T>(res: Promise<{ ok: () => boolean; status: () => number; json: () => Promise<any>; text: () => Promise<string> }>, what: string): Promise<T> {
  const r = await res;
  if (!r.ok()) throw new Error(`${what}: ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

const flags = async () => (await db.query(`SELECT kind, entity_type, reference FROM control_flags WHERE organization_id = $1 ORDER BY id`, [orgId])).rows;

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email IN ('${ALPHA}','${KEEPER}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2)`, [ALPHA, KEEPER]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E R11a Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E R11a Co',1,'gregorian')`, [orgId]);
  for (const [email, name, role] of [[ALPHA, "E2E R11a Alpha", "admin"], [KEEPER, "E2E R11a Keeper", "bookkeeper"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
  }
  alphaApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  keeperApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  for (const [api, email] of [[alphaApi, ALPHA], [keeperApi, KEEPER]] as const) {
    expect((await api.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
    expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  // ALPHA makes a journal entry and approves it: one person, both acts — a self-approval flag.
  const account = async (code: string) => (await db.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
  const je = await json<{ id: number }>(alphaApi.post("/api/journal-entries", { data: { entryNumber: ENTRY, date: "2026-10-01", description: "R-11a accrual", lines: [
    { accountId: await account("OTHER_EXPENSES"), accountName: "Other Expenses", debitAmount: 100, creditAmount: 0 },
    { accountId: await account("OTHER_INCOME"), accountName: "Other Income", debitAmount: 0, creditAmount: 100 },
  ] } }), "journal entry");
  await json(alphaApi.post(`/api/journal-entries/${je.id}/approve`, { data: {} }), "approve");
  alphaState = await alphaApi.storageState();
  keeperState = await keeperApi.storageState();
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await alphaApi?.dispose();
  await keeperApi?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

test.describe.serial("R-11a (DR-14) — a self-approval is flagged where the approvers look", () => {
  test("🔴 EN desktop: the admin sees Control flags, its total, and the flag naming them and the entry", async ({ browser }) => {
    expect(await flags(), "the act wrote one flag").toEqual([{ kind: "self_approval", entity_type: "journal_entry", reference: ENTRY }]);
    const ctx = await browser.newContext({ storageState: alphaState, viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto("/company", { waitUntil: "networkidle" });
    await setLang(page, "en");
    const section = page.getByTestId("control-flags");
    await expect(section).toContainText("Control flags");
    await expect(page.getByTestId("control-flags-total")).toHaveText("(1)");
    const row = section.locator("[data-kind='self_approval']");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Approved a document they made");
    await expect(row).toContainText(`Journal entry ${ENTRY}`);
    await expect(row).toContainText("E2E R11a Alpha");
    await ctx.close();
  });

  test("🔴 AR phone: the same section in Arabic, with no sideways scroll", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: alphaState, viewport: PHONE });
    const page = await ctx.newPage();
    await page.goto("/company", { waitUntil: "networkidle" });
    await setLang(page, "ar");
    const section = page.getByTestId("control-flags");
    await expect(section).toContainText("تنبيهات الرقابة");
    await expect(section.locator("[data-kind='self_approval']")).toContainText("اعتمد مستندًا أعدّه بنفسه");
    await expect(section.locator("[data-kind='self_approval']")).toContainText(`قيد يومية ${ENTRY}`);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w, "no sideways page scroll on a phone").toBeLessThanOrEqual(PHONE.width + 1);
    await ctx.close();
  });

  test("🔴 the bookkeeper's Company settings shows no flags section — the page itself renders", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: keeperState, viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto("/company", { waitUntil: "networkidle" });
    await setLang(page, "en");
    await expect(page.getByTestId("select-vat-tax-period"), "the page rendered").toBeVisible();
    await expect(page.getByTestId("control-flags")).toHaveCount(0);
    expect((await keeperApi.get("/api/control-flags")).status(), "and the server refuses them the flags").toBe(403);
    await ctx.close();
  });
});
