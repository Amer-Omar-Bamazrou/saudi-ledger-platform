import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * 🔴 Phase 18 final round (owner, 2026-11-04), the walk's Arabic and steps findings, register §11.138. In Arabic at 390 px:
 * 10. Verification documents read السجل التجاري · شهادة ضريبة القيمة المضافة · أخرى.
 * 11. Customer pages: البريد الإلكتروني, and "30 يومًا".
 * 12. Figures show ر.س, not SAR.
 * 14. The review screen says which documents, that the company is reviewed first, and that it shows the result itself.
 *     No time promise. (It said "sign in again" until N-3: the owner reversed that, 2026-11-07.)
 * 15. The two name fields are labelled, and an Arabic name is not tagged as needing translation.
 * 16. The Submit button reads تقديم للاعتماد.
 * 17. One name: الاعتمادات for the menu and the page, بانتظار الاعتماد for the state, and a link to where approval happens.
 * 🔴 Its OWN tenants, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-z5-${STAMP}`;
const PENDING_SLUG = `e2e-z5-pending-${STAMP}`;
const ADMIN = `e2e-z5-admin-${STAMP}@smoke.local`;
const PENDING = `e2e-z5-pending-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const LATIN_CUSTOMER = `Z5 Latin Customer ${STAMP}`;
const ARABIC_CUSTOMER = `شركة زد خمسة ${STAMP}`;

let db: Db;
let adminApi: APIRequestContext;
let pendingApi: APIRequestContext;
let invoiceId = 0;

async function removeTenants() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug IN ('${SLUG}','${PENDING_SLUG}'))`;
  const users = `(SELECT id FROM users WHERE email IN ('${ADMIN}','${PENDING}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug IN ($1,$2)`, [SLUG, PENDING_SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2)`, [ADMIN, PENDING]);
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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Z5 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  const pendingOrg = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Z5 Pending', $1, 'pending_review') RETURNING id`, [PENDING_SLUG])).rows[0].id;
  for (const id of [orgId, pendingOrg]) await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Z5 Co',1,'gregorian')`, [id]);
  for (const [email, name, org] of [[ADMIN, "E2E Z5 Admin", orgId], [PENDING, "E2E Z5 Pending", pendingOrg]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [org, id]);
  }
  adminApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  pendingApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await adminApi.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await adminApi.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  expect((await pendingApi.post("/api/auth/login", { data: { email: PENDING, password: PASSWORD } })).ok()).toBeTruthy();
  const customer = (await ok<{ id: number }>(adminApi.post("/api/customers", { data: { name: LATIN_CUSTOMER, paymentTermsDays: "30" } }), "customer")).id;
  await ok(adminApi.post("/api/customers", { data: { name: ARABIC_CUSTOMER, paymentTermsDays: "30" } }), "Arabic-named customer");
  await ok(adminApi.post("/api/bank-accounts", { data: { name: "Z5 Bank", bankName: "SNB", currency: "SAR" } }), "bank");
  invoiceId = (await ok<{ id: number }>(adminApi.post("/api/invoices", { data: { invoiceNumber: `Z5-INV-${STAMP}`, date: "2026-10-05", dueDate: "2026-10-31", customerId: customer,
    items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] } }), "invoice")).id;
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await adminApi?.dispose();
  await pendingApi?.dispose();
  if (db) {
    await removeTenants();
    await db.end();
  }
});

async function arabicPhone(browser: Browser, api: APIRequestContext, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

test.describe("Arabic wording and steps", () => {
  test("🔴 10 + 14. the review screen names the documents and the step, promises no time, and its list is in Arabic", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, pendingApi, "/verification");
    const steps = page.getByTestId("verification-pending-steps");
    await expect(steps).toContainText("السجل التجاري");
    await expect(steps).toContainText("شهادة ضريبة القيمة المضافة");
    await expect(steps, "reviewed before it can be used").toContainText("قبل");
    // N-3 (the owner, 2026-11-07): the requirement this line held is reversed; it now holds the reversal and the new step.
    await expect(steps, "no sign-in-again step").not.toContainText("سجّل الدخول");
    await expect(steps, "the screen shows the result itself").toContainText("تتحدث تلقائيًا");
    const said = (await steps.innerText()) ?? "";
    for (const promise of ["خلال", "ساعة", "ساعات", "أيام", "يوم", "فور", "قريب"]) expect(said, `no time promise: ${promise}`).not.toContain(promise);
    await expect(page.locator("select option")).toHaveText(["السجل التجاري", "شهادة ضريبة القيمة المضافة", "أخرى"]);
    await close();
  });

  test("🔴 11 + 15. the customer form's labels, the payment terms, and the Arabic-name tag", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, adminApi, "/customers");
    await expect(page.getByText("30 يومًا").first(), "the payment terms, in words").toBeVisible();
    await expect(page.getByText(/^30d$/), "not 30d").toHaveCount(0);
    const latin = page.locator("tr", { hasText: LATIN_CUSTOMER });
    const arabic = page.locator("tr", { hasText: ARABIC_CUSTOMER });
    await expect(latin.getByText("يحتاج إلى ترجمة عربية"), "a Latin name with no Arabic still shows the tag").toBeVisible();
    await expect(arabic.getByText("يحتاج إلى ترجمة عربية"), "an Arabic name does not").toHaveCount(0);
    await page.getByRole("button", { name: /عميل/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("اسم الشركة (بالإنجليزية)", { exact: false })).toBeVisible();
    await expect(dialog.getByText("اسم الشركة (بالعربية)", { exact: false })).toBeVisible();
    await expect(dialog.getByText("البريد الإلكتروني")).toBeVisible();
    await expect(dialog.getByText("Email", { exact: true }), "no English label").toHaveCount(0);
    await close();
  });

  test("🔴 12. figures show ر.س and never SAR, and a figure moves with the language", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, adminApi, "/invoices");
    for (const path of ["/invoices", "/bank-accounts", "/vat", "/customers"]) {
      await page.goto(path, { waitUntil: "networkidle" });
      const text = await page.locator("body").innerText();
      expect(text, `${path}: no SAR`).not.toContain("SAR");
    }
    await page.goto("/invoices?status=draft", { waitUntil: "networkidle" });
    const row = page.locator("tbody tr", { hasText: `Z5-INV-${STAMP}` });
    await expect(row).toContainText("1,150.00 ر.س");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("tbody tr", { hasText: `Z5-INV-${STAMP}` }), "English keeps SAR").toContainText("SAR");
    await close();
  });

  test("🔴 16 + 17. Submit reads تقديم للاعتماد, and the screen then says where approval happens, with a link that works", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, adminApi, "/invoices?status=draft");
    // The filter's list is closed at this point, so its option is in the page without being shown.
    await expect(page.getByText("بانتظار الاعتماد").first(), "the filter's word for the state").toBeAttached();
    await expect(page.getByText("بانتظار الموافقة"), "one word for the state").toHaveCount(0);
    const submit = page.getByTestId(`submit-invoice-${invoiceId}`);
    await expect(submit).toHaveText("تقديم للاعتماد");
    await submit.click();
    await expect(page.getByText("قُدّم للاعتماد").first()).toBeVisible();
    const link = page.getByTestId("submitted-approvals-link");
    await expect(link).toHaveText("الاعتمادات");
    await page.goto("/invoices?status=submitted", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`where-approve-invoice-${invoiceId}`), "the row keeps saying where").toBeVisible();
    await page.getByTestId(`where-approve-invoice-${invoiceId}`).click();
    await expect(page).toHaveURL(/\/approvals/);
    await expect(page.locator("h1").first()).toContainText("الاعتمادات");
    await close();
  });

  test("🔴 17. the menu item and the page carry one name", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, adminApi, "/");
    await page.getByTestId("nav-hamburger").click();
    const drawer = page.getByTestId("nav-drawer");
    await expect(drawer.getByText("مهامي"), "the old name is gone").toHaveCount(0);
    await drawer.getByRole("link", { name: "الاعتمادات" }).first().click();
    await expect(page).toHaveURL(/\/approvals/);
    await expect(page.locator("h1").first()).toContainText("الاعتمادات");
    await close();
  });
});
