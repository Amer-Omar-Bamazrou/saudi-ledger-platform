import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * 🔴 Phase 18 final round (owner, 2026-11-04), walk findings 5 and 6, register §11.140, in Arabic at 390 px:
 *  5. "A row's actions, and the payment form: both name the invoice number and the customer."
 *  6. "Approving an invoice asks for confirmation first. The dialog names the invoice, the customer and the total, and says:
 *     issuing is final; the invoice cannot be edited afterwards; corrections are made with a credit note."
 *
 * Presence, absence and movement for 6: the dialog says all of it, nothing has been issued while it is open, cancelling
 * leaves the invoice waiting, and only confirming issues it. 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-z7-${STAMP}`;
const ADMIN = `e2e-z7-admin-${STAMP}@smoke.local`;
const KEEPER = `e2e-z7-keeper-${STAMP}@smoke.local`;
const CUSTOMER = `Z7 Customer ${STAMP}`;
const WAITING = `Z7-WAIT-${STAMP}`;
const ISSUED = `Z7-ISSUED-${STAMP}`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let adminApi: APIRequestContext;
let keeperApi: APIRequestContext;
let waitingId = 0;
let issuedId = 0;

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Z7 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Z7 Co','1010404040','300000000000003',1,'gregorian')`, [orgId]);
  for (const [email, name, role] of [[ADMIN, "E2E Z7 Admin", "admin"], [KEEPER, "E2E Z7 Keeper", "bookkeeper"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
  }
  adminApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  keeperApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  for (const [api, email] of [[adminApi, ADMIN], [keeperApi, KEEPER]] as const) {
    expect((await api.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
    expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  const customer = (await ok<{ id: number }>(adminApi.post("/api/customers", { data: { name: CUSTOMER } }), "customer")).id;
  await ok(adminApi.post("/api/bank-accounts", { data: { name: "Z7 Bank", bankName: "SNB", currency: "SAR", isDefault: true } }), "bank");
  const invoice = (invoiceNumber: string) => ({ data: { invoiceNumber, date: "2026-10-05", dueDate: "2026-10-31", customerId: customer, items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] } });
  issuedId = (await ok<{ id: number }>(adminApi.post("/api/invoices", invoice(ISSUED)), "issued invoice")).id;
  await ok(adminApi.post(`/api/invoices/${issuedId}/approve`), "issue");
  waitingId = (await ok<{ id: number }>(keeperApi.post("/api/invoices", invoice(WAITING)), "waiting invoice")).id;
  await ok(keeperApi.post(`/api/invoices/${waitingId}/submit`, { data: {} }), "submit");
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

async function arabicPhone(browser: Browser, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await adminApi.storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

const statusOf = async (id: number) => (await db.query(`SELECT status FROM invoices WHERE id = $1`, [id])).rows[0]?.status as string;

test.describe("naming the invoice, and confirming before it is issued", () => {
  test("🔴 5. a row's actions name the invoice and the customer, and so does the payment form", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/invoices?status=sent");
    const names = page.getByTestId(`invoice-actions-for-${issuedId}`);
    await expect(names).toContainText(ISSUED);
    await expect(names).toContainText(CUSTOMER);
    await names.scrollIntoViewIfNeeded();
    await expect(names, "it is in view with the buttons").toBeInViewport();
    await expect(page.getByTestId(`mark-paid-${issuedId}`)).toBeInViewport();
    await page.getByTestId(`mark-paid-${issuedId}`).click();
    const form = page.getByRole("dialog");
    await expect(form.getByTestId("pay-invoice-names")).toContainText(ISSUED);
    await expect(form.getByTestId("pay-invoice-names")).toContainText(CUSTOMER);
    await close();
  });

  test("🔴 6. approving asks first: the dialog says all of it, cancelling changes nothing, and only confirming issues", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/approvals");
    await page.getByTestId(`approval-approve-invoices-${waitingId}`).click();
    const dialog = page.getByTestId("issue-confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(WAITING);
    await expect(dialog).toContainText(CUSTOMER);
    await expect(dialog).toContainText("1,150.00");
    await expect(dialog, "issuing is final").toContainText("الإصدار نهائي");
    await expect(dialog, "it cannot be edited afterwards").toContainText("لا يمكن تعديل الفاتورة");
    await expect(dialog, "corrections are made with a credit note").toContainText("بإشعار دائن");
    expect(await statusOf(waitingId), "nothing is issued while the dialog is open").toBe("submitted");
    await page.getByTestId("issue-confirm-cancel").click();
    await expect(dialog).toHaveCount(0);
    expect(await statusOf(waitingId), "cancelling leaves it waiting").toBe("submitted");
    await page.getByTestId(`approval-approve-invoices-${waitingId}`).click();
    await page.getByTestId("issue-confirm-approve").click();
    await expect.poll(() => statusOf(waitingId), { message: "confirming issues it" }).toBe("sent");
    await close();
  });
});
