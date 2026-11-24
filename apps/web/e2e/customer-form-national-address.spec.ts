import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 THE CUSTOMER FORM, THROUGH THE CLIENT (owner, 2026-11-24). Arabic, 390 px. Every value below is TYPED into the form
 * and SAVED by its own request; what the server stored is then read back — the client path a server test cannot see.
 *
 *  - The admin creates a Saudi business customer: typing a VAT number marks the national-address fields required (a
 *    tax invoice needs them); the street, building number, district, city, postal code and additional number are saved
 *    as typed; an invoice to that customer is then approved IN THE APPROVALS QUEUE and issues.
 *  - A customer saved with a VAT number and no national address: approving its invoice in the queue is REFUSED, and the
 *    page says why in Arabic — nothing is issued.
 *  - The bookkeeper edits the customer: the national ID field starts empty ("saved, not shown to your role"), a typed ID
 *    is saved, and the page never shows it back — it is marked withheld (D2, S2b).
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-custform-${STAMP}`;
const USERS = { admin: `e2e-custform-adm-${STAMP}@smoke.local`, bookkeeper: `e2e-custform-keep-${STAMP}@smoke.local` } as const;
type Role = keyof typeof USERS;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const ADDRESS = { buildingNumber: "4321", street: "شارع العليا", district: "حي العليا", city: "الرياض", postalCode: "12211", additionalNumber: "6789" };
const NATIONAL_ID = "1084215588";

let db: Db;
const api = {} as Record<Role, APIRequestContext>;

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Customer Form Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Customer Form Co','1010707070','319292929292973','1234','King Fahd Road','Al Olaya','Riyadh','12345',1,'gregorian')`, [orgId]);
  for (const role of Object.keys(USERS) as Role[]) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [USERS[role], `E2E CustForm ${role}`, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    api[role] = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
    const login = await api[role].post("/api/auth/login", { data: { email: USERS[role], password: PASSWORD } });
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

async function customerByName(name: string) {
  return (await db.query(`SELECT id, tax_number, building_number, street, district, city, postal_code, additional_number, country, national_id FROM customers WHERE name = $1 AND organization_id = (SELECT id FROM organizations WHERE slug = $2)`, [name, SLUG])).rows[0];
}

async function createThroughForm(page: Page, values: Record<string, string>) {
  await page.getByTestId("customer-new").click();
  await expect(page.getByTestId("customer-form")).toBeVisible();
  for (const [field, value] of Object.entries(values)) await page.getByTestId(`customer-form-${field}`).fill(value);
  await page.getByTestId("customer-form-save").click();
  await expect(page.getByTestId("customer-form")).toHaveCount(0);
}

async function issueThroughQueue(page: Page, customerId: number): Promise<number> {
  const draft = await api.admin.post("/api/invoices", { data: { date: "2026-08-01", dueDate: "2026-08-31", customerId, items: [{ description: "خدمات استشارية", quantity: 1, unitPrice: 1000, vatRate: 15, taxCategoryCode: "S", unitCode: "PCE" }] } });
  expect(draft.status(), await draft.text()).toBe(201);
  const id = (await draft.json()).id as number;
  expect((await api.admin.post(`/api/invoices/${id}/submit`, { data: {} })).ok()).toBeTruthy();
  await page.goto("/approvals", { waitUntil: "networkidle" });
  await page.getByTestId(`approval-approve-invoices-${id}`).click();
  await page.getByTestId("issue-confirm-approve").click();
  return id;
}

test.describe.serial("the customer form — the national address and the national ID (Arabic, 390 px)", () => {
  test("🔴 admin: a VAT number marks the national address required; typed and saved, the customer's standard invoice issues from the queue", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "admin", "/customers");
    await page.getByTestId("customer-new").click();
    await page.getByTestId("customer-form-taxNumber").fill("300000000000003");
    await expect(page.getByTestId("customer-form-address-required")).toBeVisible();
    for (const f of ["street", "buildingNumber", "postalCode", "city", "district"]) await expect(page.getByTestId(`customer-form-required-${f}`), f).toBeVisible();
    await fitsAtPhoneWidth(page, "the customer form (admin)");
    await page.keyboard.press("Escape");
    await createThroughForm(page, { name: "شركة الواحة", taxNumber: "300000000000003", crNumber: "1010202020", ...ADDRESS });
    const row = await customerByName("شركة الواحة");
    expect([row.building_number, row.street, row.district, row.city, row.postal_code, row.additional_number, row.country]).toEqual([ADDRESS.buildingNumber, ADDRESS.street, ADDRESS.district, ADDRESS.city, ADDRESS.postalCode, ADDRESS.additionalNumber, "SA"]);
    const id = await issueThroughQueue(page, row.id);
    await expect.poll(async () => (await db.query(`SELECT icv IS NOT NULL AS issued FROM invoices WHERE id = $1`, [id])).rows[0].issued).toBe(true);
    await close();
  });

  test("🔴 admin: a customer saved with a VAT number and no national address — approving its invoice is refused, and the page says why; nothing is issued", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "admin", "/customers");
    await createThroughForm(page, { name: "شركة النخيل", taxNumber: "300000000000003", city: "جدة" });
    const row = await customerByName("شركة النخيل");
    const id = await issueThroughQueue(page, row.id);
    await expect(page.getByText("تحتاج الفاتورة الضريبية عنوان المشتري").first()).toBeVisible();
    expect((await db.query(`SELECT status, icv FROM invoices WHERE id = $1`, [id])).rows[0]).toEqual({ status: "submitted", icv: null });
    await close();
  });

  test("🔴 bookkeeper: the national ID is entered without being read back — empty with the hint, saved as typed, marked withheld on the page", async ({ browser }) => {
    const row = await customerByName("شركة الواحة");
    const { page, close } = await pageAs(browser, "bookkeeper", `/customers/${row.id}`);
    await page.getByTestId("customer-edit").click();
    await expect(page.getByTestId("customer-form-nationalId")).toHaveValue("");
    await page.getByTestId("customer-form-nationalId").fill(NATIONAL_ID);
    await page.getByTestId("customer-form-save").click();
    await expect(page.getByTestId("customer-form")).toHaveCount(0);
    expect((await customerByName("شركة الواحة")).national_id).toBe(NATIONAL_ID);
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("customer-national-id-withheld")).toBeVisible();
    expect((await page.content()).includes(NATIONAL_ID)).toBe(false);
    await page.getByTestId("customer-edit").click();
    await expect(page.getByTestId("customer-form-nationalId")).toHaveValue(""); // still never read back
    await expect(page.getByText("محفوظ ولا يظهر لدورك").first()).toBeVisible();
    await fitsAtPhoneWidth(page, "the customer edit form (bookkeeper)");
    await close();
  });
});
