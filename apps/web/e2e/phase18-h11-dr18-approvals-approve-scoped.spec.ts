import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "./fixtures";

/**
 * 🔴 Phase 18 R-12 step 3 — DR-18 reading (c) (register §11.59–§11.61, §11.118): the approvals queue lists what the
 * caller's role can APPROVE, each item the caller made marked "Yours".
 *
 *  - The BOOKKEEPER's queue lists neither waiting invoice (a bookkeeper approves nothing), and the page says whose
 *    items it holds; their own submitted invoice reads submitted on the invoices page instead.
 *  - The ADMIN's queue lists both, and only the admin's own is marked "Yours" — in English, and in Arabic on a phone.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-h11-${STAMP}`;
const ALPHA = `e2e-h11-alpha-${STAMP}@smoke.local`;
const KEEPER = `e2e-h11-keeper-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let alphaApi: APIRequestContext;
let keeperApi: APIRequestContext;
let alphaState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let keeperState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let orgId = "";
let keepersInvoice = 0;
let alphasInvoice = 0;

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
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E H11 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E H11 Co',1,'gregorian')`, [orgId]);
  for (const [email, name, role] of [[ALPHA, "E2E H11 Alpha", "admin"], [KEEPER, "E2E H11 Keeper", "bookkeeper"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
  }
  alphaApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  keeperApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  for (const [api, email] of [[alphaApi, ALPHA], [keeperApi, KEEPER]] as const) {
    expect((await api.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
    expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  const customer = (await json<{ id: number }>(alphaApi.post("/api/customers", { data: { name: `H11 Customer ${STAMP}` } }), "customer")).id;
  const invoice = (api: APIRequestContext, n: string) => json<{ id: number }>(api.post("/api/invoices", { data: { invoiceNumber: `H11-${n}-${STAMP}`, date: "2026-10-05", dueDate: "2026-10-31", customerId: customer,
    items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] } }), `invoice ${n}`);
  keepersInvoice = (await invoice(keeperApi, "K")).id;
  await json(keeperApi.post(`/api/invoices/${keepersInvoice}/submit`, { data: {} }), "submit");
  alphasInvoice = (await invoice(alphaApi, "A")).id;
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

test.describe.serial("R-12 step 3 (DR-18) — the approvals queue lists what your role can approve", () => {
  test("🔴 the bookkeeper's queue lists neither waiting invoice, and says whose items it holds; their own reads submitted on its page", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: keeperState, viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto("/approvals", { waitUntil: "networkidle" });
    await setLang(page, "en");
    await expect(page.getByText("What your role can approve, waiting")).toBeVisible();
    await expect(page.getByTestId(`approval-invoices-${keepersInvoice}`)).toHaveCount(0);
    await expect(page.getByTestId(`approval-invoices-${alphasInvoice}`)).toHaveCount(0);
    await page.goto("/invoices", { waitUntil: "networkidle" });
    await expect(page.locator("tr", { hasText: `H11-K-${STAMP}` })).toContainText("submitted");
    await ctx.close();
  });

  test("🔴 the admin's queue lists both, and only the admin's own is marked Yours", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: alphaState, viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto("/approvals", { waitUntil: "networkidle" });
    await setLang(page, "en");
    await expect(page.getByTestId(`approval-invoices-${keepersInvoice}`)).toBeVisible();
    await expect(page.getByTestId(`approval-invoices-${alphasInvoice}`)).toBeVisible();
    await expect(page.getByTestId(`approval-own-invoices-${alphasInvoice}`)).toHaveText("Yours");
    await expect(page.getByTestId(`approval-own-invoices-${keepersInvoice}`), "the bookkeeper's item is not the admin's").toHaveCount(0);
    await ctx.close();
  });

  test("🔴 AR phone: the admin's own item is marked in Arabic, with no sideways scroll", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: alphaState, viewport: PHONE });
    const page = await ctx.newPage();
    await page.goto("/approvals", { waitUntil: "networkidle" });
    await setLang(page, "ar");
    await expect(page.getByTestId(`approval-own-invoices-${alphasInvoice}`)).toHaveText("من إعدادك");
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w, "no sideways page scroll on a phone").toBeLessThanOrEqual(PHONE.width + 1);
    await ctx.close();
  });
});
