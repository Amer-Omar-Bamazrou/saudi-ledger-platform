import { test, expect, request as pwRequest, type APIRequestContext, type Browser } from "./fixtures";

/**
 * 🔴 Phase 18 final round (owner, 2026-11-04): "the New Bill dialog offers a bookkeeper only what that role may do under
 * DR-20." Register §11.136.
 *
 * Posting a bill is an approver's act (`approve`: admin, accountant). The dialog used to offer a bookkeeper "Post Bill",
 * then send the post the server was bound to refuse: a 403 notice on top of a bill that had in fact been saved.
 *
 * Presence, absence and movement: the bookkeeper is offered "save as a draft", no post request leaves the page, no error
 * shows, and the bill is a draft they can then submit; the admin, in the same dialog, is still offered the post and the
 * bill moves. In Arabic at 390 px. 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-z3-${STAMP}`;
const ADMIN = `e2e-z3-admin-${STAMP}@smoke.local`;
const KEEPER = `e2e-z3-keeper-${STAMP}@smoke.local`;
const VENDOR = `Z3 Supplier ${STAMP}`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let adminApi: APIRequestContext;
let keeperApi: APIRequestContext;
let orgId = "";

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email IN ('${ADMIN}','${KEEPER}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2)`, [ADMIN, KEEPER]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Z3 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Z3 Co',1,'gregorian')`, [orgId]);
  for (const [email, name, role] of [[ADMIN, "E2E Z3 Admin", "admin"], [KEEPER, "E2E Z3 Keeper", "bookkeeper"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
  }
  adminApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  keeperApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  for (const [api, email] of [[adminApi, ADMIN], [keeperApi, KEEPER]] as const) {
    expect((await api.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
    expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  expect((await adminApi.post("/api/vendors", { data: { name: VENDOR, residency: "resident" } })).ok()).toBeTruthy();
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await adminApi?.dispose();
  await keeperApi?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

/** A phone-width Arabic page signed in through `api`, with the New Bill dialog open and filled, not yet saved. */
async function openFilledDialog(browser: Browser, api: APIRequestContext, billNumber: string) {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto("/bills", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "فاتورة جديدة" }).click();
  await page.getByTestId("bill-number").fill(billNumber);
  await page.getByTestId("bill-vendor").click();
  await page.getByRole("option", { name: VENDOR }).click();
  await page.getByTestId("bill-subtotal").fill("100");
  await page.getByTestId("bill-vat").fill("0");
  await page.getByTestId("bill-total").fill("100");
  return { ctx, page };
}

const billRow = async (billNumber: string) =>
  (await db.query(`SELECT id, status FROM bills WHERE organization_id = $1 AND bill_number = $2`, [orgId, billNumber])).rows[0] as { id: number; status: string } | undefined;
const ledgerEntries = async () => (await db.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n as number;

test.describe.serial("the New Bill dialog offers each role what it may do", () => {
  test("🔴 a bookkeeper is offered a draft: nothing asks the server to post, no error shows, and the draft can be submitted", async ({ browser }) => {
    const number = `Z3-K-${STAMP}`;
    const { ctx, page } = await openFilledDialog(browser, keeperApi, number);
    const button = page.getByTestId("bill-submit");
    await expect(button, "the button says what will happen").toHaveText("حفظ كمسودة");
    await expect(page.getByTestId("bill-draft-hint"), "and who posts it").toContainText("المعتمد");
    const posts: string[] = [];
    page.on("request", (r) => {
      if (/\/api\/bills\/\d+\/post$/.test(new URL(r.url()).pathname)) posts.push(r.url());
    });
    await button.click();
    await expect(page.getByText("حُفظت الفاتورة كمسودة").first()).toBeVisible();
    expect(posts, "no post request leaves the page").toEqual([]);
    await expect(page.getByText("خطأ", { exact: true }), "no error notice").toHaveCount(0);
    const row = await billRow(number);
    expect(row?.status, "a draft").toBe("draft");
    expect(await ledgerEntries(), "in no ledger").toBe(0);
    await page.getByTestId(`submit-bill-${row!.id}`).click();
    await expect.poll(async () => (await billRow(number))?.status).toBe("submitted");
    await ctx.close();
  });

  test("🔴 an admin, in the same dialog, is offered the post and the bill moves", async ({ browser }) => {
    const number = `Z3-A-${STAMP}`;
    const { ctx, page } = await openFilledDialog(browser, adminApi, number);
    const button = page.getByTestId("bill-submit");
    await expect(button).toHaveText("ترحيل الفاتورة");
    await expect(page.getByTestId("bill-draft-hint"), "no draft hint for an approver").toHaveCount(0);
    await button.click();
    await expect.poll(ledgerEntries, { message: "the bill reached the ledger" }).toBeGreaterThan(0);
    expect((await billRow(number))?.status).not.toBe("draft");
    await ctx.close();
  });
});
