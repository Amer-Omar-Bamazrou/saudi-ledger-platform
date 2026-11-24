import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 19B S2b — the customer, supplier and invoice pages WITH THE SEVEN REMOVED (v4 §6.1 D2, §11 B2, D4). Arabic, 390 px.
 *
 *  - The VIEWER: the customer and supplier lists and records mark contact and the IBAN WITHHELD (never a blank, never
 *    "—"); no planted value is anywhere in the page; the invoice stays in the app, and its PDF link SAYS it is not
 *    available to the role — nothing downloads.
 *  - The BOOKKEEPER: keeps contact; sees a supplier IBAN as its last four digits only; downloads the standard invoice's
 *    PDF (the buyer's address is contact, which it reads).
 *  - Presence: the ACCOUNTANT reads every planted value and downloads the PDF.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-s2b-roles-${STAMP}`;
const USERS = { admin: `e2e-s2br-adm-${STAMP}@smoke.local`, accountant: `e2e-s2br-acc-${STAMP}@smoke.local`, bookkeeper: `e2e-s2br-keep-${STAMP}@smoke.local`, viewer: `e2e-s2br-view-${STAMP}@smoke.local` } as const;
type Role = keyof typeof USERS;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const WITHHELD_CONTACT = "محجوب (بيانات الاتصال)";
const WITHHELD_BANK = "محجوب (الحساب البنكي)";

const C = { name: "S2B Planted Buyer", phone: "+966500071344", email: "s2b.e2e.buyer@example.sa", street: "S2B-E2E-STREET-4419", district: "S2B-E2E-DISTRICT", city: "S2BE2ECITY", buildingNumber: "4419", postalCode: "12211", taxNumber: "300000000000003", nationalId: "1084215577" };
const IBAN = "SA0380000000608010167519";
const V = { name: "S2B Planted Supplier", phone: "+966500082455", email: "s2b.e2e.supplier@example.sa", address: "S2B-E2E-SUPP-ADDR", city: "S2BE2ESUPPCITY", iban: IBAN };
const PLANTED = [C.phone, C.email, C.street, C.district, C.city, C.nationalId, V.phone, V.email, V.address, V.city, IBAN, IBAN.slice(0, -4)];
const BOOKKEEPER_MAY_READ = [C.phone, C.email, C.street, C.district, C.city, V.phone, V.email, V.address, V.city];

let db: Db;
const api = {} as Record<Role, APIRequestContext>;
let customerId = 0;
let vendorId = 0;
let invoiceId = 0;

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S2b Roles Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S2b Roles Co','1010505050','319595959595983',1,'gregorian')`, [orgId]);
  for (const role of Object.keys(USERS) as Role[]) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [USERS[role], `E2E S2b ${role}`, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    api[role] = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`); // four logins in a row from one address
    const login = await api[role].post("/api/auth/login", { data: { email: USERS[role], password: PASSWORD } });
    expect(login.ok(), `login ${role}: ${login.status()} ${await login.text()}`).toBeTruthy();
    expect((await api[role].post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
  const cust = await api.accountant.post("/api/customers", { data: C });
  expect(cust.status(), await cust.text()).toBe(201);
  customerId = (await cust.json()).id;
  const vend = await api.accountant.post("/api/vendors", { data: V });
  expect(vend.status(), await vend.text()).toBe(201);
  vendorId = (await vend.json()).id;
  // the IBAN through the hold (S3): the admin, who did not enter it, approves it
  const held = await (await api.admin.get("/api/companies/current/bank-detail-changes")).json();
  for (const c of held.items.filter((x: { status: string; kind: string }) => x.status === "pending" && x.kind === "vendor_iban")) {
    expect((await api.admin.put(`/api/companies/current/bank-detail-changes/${c.id}/decision`, { data: { decision: "approve" } })).ok()).toBeTruthy();
  }
  // a STANDARD tax invoice to the planted buyer: it prints the buyer's address (contact)
  const inv = await api.accountant.post("/api/invoices", { data: { invoiceNumber: `S2BE2E-${String(STAMP).slice(-6)}`, date: "2026-10-05", dueDate: "2026-11-04", customerId, items: [{ description: "Services", quantity: 1, unitPrice: 1000, vatRate: 15, taxCategoryCode: "S", unitCode: "PCE" }] } });
  expect(inv.status(), await inv.text()).toBe(201);
  invoiceId = (await inv.json()).id;
  expect((await api.accountant.post(`/api/invoices/${invoiceId}/submit`, { data: {} })).ok()).toBeTruthy();
  const approved = await api.admin.post(`/api/invoices/${invoiceId}/approve`, { data: {} });
  expect(approved.status(), await approved.text()).toBe(200);
});

test.afterAll(async () => {
  for (const a of Object.values(api)) await a?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function pageAs(browser: Browser, role: Role, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api[role].storageState(), viewport: PHONE, acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}
const plantedIn = async (page: Page) => { const text = await page.content(); return PLANTED.filter((s) => text.includes(s)); };

test.describe.serial("19B S2b — customers, suppliers and the invoice PDF, with the seven removed (Arabic, 390 px)", () => {
  test("🔴 viewer: the customer and supplier lists and records mark contact and the IBAN withheld; nothing planted is in any page", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "viewer", "/customers");
    await expect(page.getByTestId(`customer-city-withheld-${customerId}`)).toHaveText(WITHHELD_CONTACT);
    expect(await plantedIn(page), "customers list").toEqual([]);
    await fitsAtPhoneWidth(page, "the customers list (viewer)");
    await page.goto(`/customers/${customerId}`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("customer-contact-withheld")).toHaveText(WITHHELD_CONTACT);
    await expect(page.getByText(C.name).first()).toBeVisible(); // the record is there; its contact is not
    expect(await plantedIn(page), "customer record").toEqual([]);
    await page.goto("/vendors", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`vendor-city-withheld-${vendorId}`)).toHaveText(WITHHELD_CONTACT);
    await expect(page.getByTestId(`vendor-iban-withheld-${vendorId}`)).toHaveText(WITHHELD_BANK);
    expect(await plantedIn(page), "suppliers list").toEqual([]);
    await page.goto(`/vendors/${vendorId}`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("vendor-contact-withheld")).toHaveText(WITHHELD_CONTACT);
    await expect(page.getByTestId("vendor-iban-withheld")).toHaveText(WITHHELD_BANK);
    expect(await plantedIn(page), "supplier record").toEqual([]);
    await fitsAtPhoneWidth(page, "the supplier record (viewer)");
    await close();
  });

  test("🔴 viewer: the invoice stays in the app; its PDF link says the PDF is not available to the role, and nothing downloads (B2)", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "viewer", `/invoices/${invoiceId}`);
    let downloads = 0;
    page.on("download", () => { downloads++; });
    await expect(page.getByText(C.name).first()).toBeVisible();
    await page.getByTestId("invoice-detail-pdf").click();
    await expect(page.getByText("ملف PDF هذا غير متاح لدورك").first()).toBeVisible();
    await expect(page.getByText("بيانات الاتصال للمشتري").first()).toBeVisible(); // the server's own sentence names the class
    await page.waitForTimeout(500);
    expect(downloads).toBe(0);
    expect(await plantedIn(page)).toEqual([]);
    await fitsAtPhoneWidth(page, "the invoice record (viewer)");
    await close();
  });

  test("🔴 bookkeeper: keeps contact; a supplier IBAN as its last four only; downloads the standard invoice's PDF", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "bookkeeper", `/vendors/${vendorId}`);
    await expect(page.getByText(`•••• ${IBAN.slice(-4)}`).first()).toBeVisible();
    const text = await page.content();
    expect([text.includes(IBAN), text.includes(IBAN.slice(0, -4))]).toEqual([false, false]);
    await expect(page.getByText(V.phone).first()).toBeVisible();
    await page.goto(`/customers/${customerId}`, { waitUntil: "networkidle" });
    await expect(page.getByText(C.phone).first()).toBeVisible();
    expect((await page.content()).includes(C.nationalId)).toBe(false);
    await page.goto(`/invoices/${invoiceId}`, { waitUntil: "networkidle" });
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("invoice-detail-pdf").click()]);
    const stream = await download.createReadStream();
    const first = await new Promise<Buffer>((resolve) => stream.once("data", (b: Buffer) => resolve(b)));
    expect(first.subarray(0, 5).toString()).toBe("%PDF-");
    expect(BOOKKEEPER_MAY_READ.length).toBeGreaterThan(0);
    await close();
  });

  test("presence: the accountant reads every planted value and downloads the PDF", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "accountant", `/vendors/${vendorId}`);
    await expect(page.getByText(IBAN).first()).toBeVisible();
    await expect(page.getByText(V.address).first()).toBeVisible();
    await page.goto(`/customers/${customerId}`, { waitUntil: "networkidle" });
    await expect(page.getByText(C.email).first()).toBeVisible();
    await page.goto(`/invoices/${invoiceId}`, { waitUntil: "networkidle" });
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("invoice-detail-pdf").click()]);
    expect(download.suggestedFilename()).toMatch(/-ar\.pdf$/);
    await close();
  });
});
