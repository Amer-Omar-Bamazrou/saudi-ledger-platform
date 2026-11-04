import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * 🔴 Phase 18 final round (owner, 2026-11-04), walk finding 18, register §11.141: "A read-only invoice detail screen, opened
 * by tapping an invoice row: status, number, date, customer, seller, lines, totals, the QR code and a PDF button. No editing
 * on it." In Arabic at 390 px. The QR must really draw (its image has pixels), and a tap on a row's own button must still do
 * that button's job and not open the screen. 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-z8-${STAMP}`;
const ADMIN = `e2e-z8-admin-${STAMP}@smoke.local`;
const CUSTOMER = `Z8 Customer ${STAMP}`;
const ISSUED = `Z8-ISSUED-${STAMP}`;
const DRAFT = `Z8-DRAFT-${STAMP}`;
const SELLER = `Z8 Seller Co ${STAMP}`;
const SELLER_VAT = "300000000000003";
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let api: APIRequestContext;
let issuedId = 0;
let draftId = 0;

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

async function ok<T>(res: Promise<{ ok: () => boolean; status: () => number; json: () => Promise<any>; text: () => Promise<string> }>, what: string) {
  const r = await res;
  if (!r.ok()) throw new Error(`${what}: ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Z8 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,$2,'1010404040',$3,1,'gregorian')`, [orgId, SELLER, SELLER_VAT]);
  const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E Z8 Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, id]);
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  const customer = (await ok<{ id: number }>(api.post("/api/customers", { data: { name: CUSTOMER } }), "customer")).id;
  await ok(api.post("/api/bank-accounts", { data: { name: "Z8 Bank", bankName: "SNB", currency: "SAR", isDefault: true } }), "bank");
  const invoice = (invoiceNumber: string) => ({ data: { invoiceNumber, date: "2026-10-05", dueDate: "2026-10-31", customerId: customer, items: [{ description: "Z8 consulting", quantity: 2, unitPrice: 500, vatRate: 15 }] } });
  issuedId = (await ok<{ id: number }>(api.post("/api/invoices", invoice(ISSUED)), "issued invoice")).id;
  await ok(api.post(`/api/invoices/${issuedId}/approve`), "issue");
  draftId = (await ok<{ id: number }>(api.post("/api/invoices", invoice(DRAFT)), "draft invoice")).id;
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await api?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function arabicPhone(browser: Browser, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

test.describe("the read-only invoice screen", () => {
  test("🔴 tapping an issued invoice's row opens it: everything is there, the QR draws, a PDF button works, nothing can be edited", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/invoices?status=sent");
    await page.locator("tbody tr", { hasText: ISSUED }).getByText(CUSTOMER).first().click();
    await expect(page).toHaveURL(new RegExp(`/invoices/${issuedId}$`));
    const screen = page.getByTestId("invoice-detail");
    await expect(screen).toBeVisible();
    await expect(screen.getByTestId("invoice-detail-status")).toHaveText("صادرة");
    await expect(screen).toContainText(ISSUED);
    await expect(screen).toContainText("2026-10-05");
    await expect(screen).toContainText(CUSTOMER);
    await expect(screen.getByTestId("invoice-detail-seller")).toContainText(SELLER);
    await expect(screen.getByTestId("invoice-detail-seller")).toContainText(SELLER_VAT);
    await expect(screen.getByTestId("invoice-detail-lines")).toContainText("Z8 consulting");
    const totals = screen.getByTestId("invoice-detail-totals");
    await expect(totals).toContainText("1,000.00");
    await expect(totals).toContainText("150.00");
    await expect(totals).toContainText("1,150.00");
    const qr = screen.getByTestId("invoice-detail-qr");
    await expect(qr).toBeVisible();
    expect(await qr.evaluate((img) => (img as HTMLImageElement).naturalWidth), "the QR image has pixels").toBeGreaterThan(0);
    await expect(screen.getByTestId("invoice-detail-pdf")).toHaveAttribute("href", new RegExp(`/api/invoices/${issuedId}/document\\?lang=ar$`));
    await expect(screen.locator("input, textarea, select"), "no field to edit").toHaveCount(0);
    await expect(screen.locator("button"), "no action to take here").toHaveCount(0);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, "no sideways scroll on a phone").toBeLessThanOrEqual(PHONE.width + 1);
    await close();
  });

  test("🔴 a draft opens too, and says it has no QR or PDF until it is issued", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, `/invoices/${draftId}`);
    const screen = page.getByTestId("invoice-detail");
    await expect(screen.getByTestId("invoice-detail-status")).toHaveText("مسودة");
    await expect(screen.getByTestId("invoice-detail-qr")).toHaveCount(0);
    await expect(screen.getByTestId("invoice-detail-pdf")).toHaveCount(0);
    await expect(screen.getByTestId("invoice-detail-not-issued")).toBeVisible();
    await close();
  });

  test("🔴 a tap on a row's own button does its job and does not open the screen", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/invoices?status=sent");
    await page.getByTestId(`mark-paid-${issuedId}`).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveURL(/\/invoices\?status=sent/);
    await close();
  });

  test("an id that names nothing says so", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/invoices/2147483647");
    await expect(page.getByTestId("invoice-detail-missing")).toBeVisible();
    await close();
  });
});
