import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 19B S5 THROUGH THE PAGES. Arabic, 390 px. Each of the four datasets after journal lines has a screen that RENDERS
 * the server's rows (documents the product's own paths wrote): the viewer reads sales and purchase documents and is
 * told, in Arabic, that cash movements and VAT lines are not their role's; the bookkeeper reads all four. (The figures
 * are held by apps/api/src/tests/s5-report-datasets.test.ts.) 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-s5ds-${STAMP}`;
const USERS = { admin: `e2e-s5ds-adm-${STAMP}@smoke.local`, bookkeeper: `e2e-s5ds-keep-${STAMP}@smoke.local`, viewer: `e2e-s5ds-view-${STAMP}@smoke.local` } as const;
type Role = keyof typeof USERS;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const TODAY = new Date().toISOString().slice(0, 10);

let db: Db;
const api = {} as Record<Role, APIRequestContext>;
let invoiceNumber = "";
let billNumber = "";

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const emails = Object.values(USERS).map((e) => `'${e}'`).join(",");
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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S5 Datasets Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S5 Co','1010707075','319292929292973','1234','King Fahd Road','Al Olaya','Riyadh','12345',1,'gregorian')`, [orgId]);
  for (const role of Object.keys(USERS) as Role[]) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [USERS[role], `E2E S5 ${role}`, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    api[role] = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
    const login = await api[role].post("/api/auth/login", { data: { email: USERS[role], password: PASSWORD } });
    expect(login.ok(), `login ${role}: ${login.status()}`).toBeTruthy();
    expect((await api[role].post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  const post = async (path: string, data: unknown, status = 200) => {
    const r = await api.admin.post(path, { data });
    expect(r.status(), `${path}: ${await r.text()}`).toBe(status);
    return r.json();
  };
  const customer = await post("/api/customers", { name: "عميل نقدي" }, 201);
  const vendor = await post("/api/vendors", { name: "مورد التجربة", taxNumber: "300000000000003" }, 201);
  const inv = await post("/api/invoices", { date: TODAY, dueDate: TODAY, customerId: customer.id, items: [{ description: "خدمة", quantity: 1, unitPrice: 1000, vatRate: 15 }] }, 201);
  await post(`/api/invoices/${inv.id}/submit`, {});
  await post(`/api/invoices/${inv.id}/approve`, {});
  invoiceNumber = inv.invoiceNumber;
  const bill = await post("/api/bills", { date: TODAY, vendorId: vendor.id, vendorReference: "S5-E2E-1", supplierDocumentKind: "tax_invoice", subtotal: 400, vatAmount: 60, total: 460, items: [] }, 201);
  await post(`/api/bills/${bill.id}/post`, {});
  billNumber = bill.billNumber;
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

test.describe.serial("19B S5 — the dataset screens (Arabic, 390 px)", () => {
  test("🔴 viewer: sales and purchase documents render the server's rows; cash movements and VAT lines say, in Arabic, that the role may not use them", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "viewer", "/reports/sales-documents");
    await expect(page.getByTestId("sales-documents-table")).toBeVisible();
    await expect(page.getByTestId("sales-documents-row").filter({ hasText: invoiceNumber })).toHaveCount(1);
    await expect(page.getByTestId("sales-documents-col-signedTotal")).toContainText("الإجمالي بالإشارة");
    await fitsAtPhoneWidth(page, "the sales documents dataset");
    await page.goto("/reports/purchase-documents", { waitUntil: "networkidle" });
    await expect(page.getByTestId("purchase-documents-row").filter({ hasText: billNumber })).toHaveCount(1);
    for (const [path, slug] of [["/reports/cash-movements", "cash-movements"], ["/reports/vat-lines", "vat-lines"]] as const) {
      await page.goto(path, { waitUntil: "networkidle" });
      await expect(page.getByTestId(`${slug}-refusal`)).toContainText("دورك لا يسمح باستخدام بيانات تقرير");
      await expect(page.getByTestId(`${slug}-table`)).toHaveCount(0);
    }
    await close();
  });

  test("🔴 bookkeeper: VAT lines list the return's addends for the period with their boxes; cash movements open", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "bookkeeper", "/reports/vat-lines");
    await expect(page.getByTestId("vat-lines-table")).toBeVisible();
    // the invoice's line (box 1 and box 6), the bill's purchase amount (box 9) and its claimed input VAT (box 13)
    await expect(page.getByTestId("vat-lines-row")).toHaveCount(3);
    await expect(page.getByTestId("vat-lines-row").filter({ hasText: invoiceNumber })).toHaveCount(1);
    await expect(page.getByTestId("vat-lines-row").filter({ hasText: billNumber })).toHaveCount(2);
    await fitsAtPhoneWidth(page, "the VAT lines dataset");
    await page.goto("/reports/cash-movements", { waitUntil: "networkidle" });
    await expect(page.getByTestId("cash-movements-page")).toBeVisible();
    await expect(page.getByTestId("cash-movements-refusal")).toHaveCount(0);
    await close();
  });
});
