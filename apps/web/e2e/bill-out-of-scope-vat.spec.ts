import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 L4 THROUGH THE CLIENT (owner, 2026-11-25). Arabic, 390 px. VAT on an OUT-OF-SCOPE expense account (Government
 * fees): the bill form says the account carries no VAT; VAT typed there without a stated commercial supply is refused
 * by the server, in Arabic, and nothing is written; with the supply stated, the bill saves and posts, and the server
 * keeps the reason, who and when. In review, the stated supply is shown beside the warning before the approver posts.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-l4-oos-${STAMP}`;
const ADMIN = `e2e-l4-oos-adm-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const VENDOR = "الغرفة التجارية";
const REASON = "شهادات مطبوعة اشترتها الشركة من الغرفة — توريد تجاري بفاتورة ضريبية";

let db: Db;
let api: APIRequestContext;
let orgId = "";
let adminId = 0;
let vendorId = 0;

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

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E L4 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E L4 Co','1010707071','319292929292973','1234','King Fahd Road','Al Olaya','Riyadh','12345',1,'gregorian')`, [orgId]);
  vendorId = (await db.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,$2,'300000000000003') RETURNING id`, [orgId, VENDOR])).rows[0].id;
  adminId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E L4 admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, adminId]);
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
  const login = await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } });
  expect(login.ok(), `login: ${login.status()}`).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
});

test.afterAll(async () => {
  await api?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function pageAs(browser: Browser, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

const bills = async () => (await db.query(`SELECT id, vat_amount, commercial_supply_reason, commercial_supply_stated_by, commercial_supply_stated_at, input_vat_state, status FROM bills WHERE organization_id = $1 ORDER BY id`, [orgId])).rows;

test.describe.serial("L4 — VAT on an out-of-scope account (Arabic, 390 px)", () => {
  test("🔴 entry: the account says VAT is 0; VAT without a stated supply is refused in Arabic and nothing is written; with it, the bill posts and the server keeps who and why", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "/bills");
    await page.getByRole("button", { name: "فاتورة جديدة" }).click();
    await page.getByTestId("bill-vendor").click();
    await page.getByRole("option", { name: VENDOR }).click();
    await page.getByTestId("bill-document-kind").click();
    await page.getByTestId("bill-document-kind-tax_invoice").click();
    await page.getByTestId("bill-vendor-reference").fill("CHAMBER-77");
    await page.getByTestId("bill-expense-account").click();
    await page.getByTestId("bill-expense-account-GOVT_FEES").click();
    await page.getByTestId("bill-subtotal").fill("500");
    await page.getByTestId("bill-total").fill("500");
    // the account carries no VAT, and the form says so before any is typed
    await expect(page.locator('[data-testid="vat-evidence-panel"] [data-code="out_of_scope_account"]')).toBeVisible();
    await expect(page.getByTestId("commercial-supply")).toHaveCount(0);
    // VAT typed on it: the server's preview holds it and asks for the supply
    await page.getByTestId("bill-vat").fill("75");
    await page.getByTestId("bill-total").fill("575");
    await expect(page.locator('[data-code="out_of_scope_account_vat_unstated"]')).toBeVisible();
    await expect(page.getByTestId("commercial-supply")).toBeVisible();
    await fitsAtPhoneWidth(page, "the bill form with the commercial-supply field");
    await page.getByTestId("bill-submit").click();
    await expect(page.getByText("خارج نطاق ضريبة القيمة المضافة").first()).toBeVisible();
    expect(await bills()).toEqual([]);
    // stated: saved, posted, the VAT claimed on its tax invoice; the reason, who and when kept
    await page.getByTestId("commercial-supply-reason").fill(REASON);
    await expect(page.locator('[data-code="out_of_scope_account_commercial_supply"]')).toBeVisible();
    await page.getByTestId("bill-submit").click();
    // the form saves, then posts (two requests): wait for the posted state
    await expect.poll(async () => (await bills())[0]?.input_vat_state ?? null).toBe("claimed");
    const rows = await bills();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ vat_amount: "75.00", commercial_supply_reason: REASON, commercial_supply_stated_by: adminId, input_vat_state: "claimed" });
    expect(row.commercial_supply_stated_at).not.toBeNull();
    await close();
  });

  test("🔴 review: the approver reads the stated supply beside the warning before posting", async ({ browser }) => {
    const govtFees = (await db.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'GOVT_FEES'`, [orgId])).rows[0].id;
    const draft = await api.post("/api/bills", { data: { date: "2026-08-03", vendorId, vendorReference: "CHAMBER-78", supplierDocumentKind: "tax_invoice", subtotal: 200, vatAmount: 30, total: 230, expenseAccountId: govtFees, commercialSupplyReason: REASON, items: [] } });
    expect(draft.status(), await draft.text()).toBe(201);
    const id = (await draft.json()).id as number;
    const { page, close } = await pageAs(browser, "/bills");
    await page.getByTestId(`bill-post-${id}`).click();
    await expect(page.locator('[data-code="out_of_scope_account_commercial_supply"]')).toBeVisible();
    await expect(page.getByTestId("post-commercial-supply")).toContainText(REASON);
    await fitsAtPhoneWidth(page, "the bill review with the stated supply");
    await page.getByTestId("bill-post-confirm").click();
    await expect.poll(async () => (await db.query(`SELECT status FROM bills WHERE id = $1`, [id])).rows[0].status).not.toBe("draft");
    await close();
  });
});
