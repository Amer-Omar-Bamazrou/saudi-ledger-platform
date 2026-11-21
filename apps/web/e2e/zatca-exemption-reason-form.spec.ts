import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 THE INVOICE FORM SENDS A ZERO-RATED LINE'S REASON, FROM ZATCA'S LIST, IN ARABIC (owner, 2026-11-21).
 *
 * The invoice API used to drop a line's exemption reason, and the form could not state one (nor even the line's VAT
 * category). A server test cannot see what the page sends, so this is clicked, in Arabic at 390 px:
 *   - a line is set to zero-rated, its VAT % is fixed at 0, and its reason is chosen from ZATCA's list shown in Arabic
 *     (VATEX-SA-EDU, "الخدمات التعليمية الخاصة للمواطنين"); the REQUEST the form sends carries the category and the
 *     code; the invoice issues (to a citizen with a national ID: BR-KSA-49);
 *   - a zero-rated line saved WITHOUT its reason is a draft the server accepts, and its approval is refused, the reason
 *     named in Arabic, and nothing is issued.
 * Its OWN tenant, removed afterwards.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };
const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-zexr-${STAMP}`;
const ADMIN = `e2e-zexr-admin-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const CITIZEN = "عبدالرحمن الحربي";

let db: Db;
let admin: APIRequestContext;
let orgId = "";

async function removeTenant() {
  const users = `(SELECT id FROM users WHERE email = '${ADMIN}')`;
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  await db.query(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${orgs})`);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM session_records WHERE user_id IN ${users}`);
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
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Exemption Reasons', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(
    `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start, fiscal_calendar, building_number, street, district, city, postal_code, additional_number)
     VALUES ($1,'Al-Noor Private School','مدارس النور الأهلية','1010101049','310123456789013',1,'gregorian','1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
  const uid = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E Exemption Admin',$2,'viewer',true) RETURNING id`, [ADMIN, await bcrypt.hash(PASSWORD, 4)])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, uid]);
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
  admin = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await admin.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await admin.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  // a citizen with a Saudi national ID — what an education invoice must name (BR-KSA-49)
  expect((await admin.post("/api/customers", { data: { name: "Abdulrahman Al-Harbi", nameAr: CITIZEN, nationalId: "1012345678" } })).ok()).toBeTruthy();
});

test.afterAll(async () => {
  await admin?.dispose();
  if (db) { await removeTenant(); await db.end(); }
});

async function open(browser: Browser, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await admin.storageState(), viewport: PHONE, locale: "ar-SA" });
  await ctx.addInitScript(() => { try { localStorage.setItem("ksa_lang", "ar"); } catch { /* the default language */ } });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

/** Fill one zero-rated line in the open dialog; `reason` null leaves it unchosen. Returns the request the form sends. */
async function createZeroRated(page: Page, description: string, reason: string | null) {
  await page.getByRole("button", { name: "فاتورة جديدة" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("الوصف").first().fill(description);
  await dialog.getByPlaceholder("الكمية").first().fill("1");
  await dialog.getByPlaceholder("سعر الوحدة").first().fill("1000");
  await dialog.getByRole("combobox").filter({ hasText: "اختر العميل" }).click();
  await page.getByRole("option", { name: CITIZEN }).click();
  await dialog.getByTestId("invoice-line-0-category").selectOption("Z");
  await expect(dialog.getByRole("spinbutton", { name: "الضريبة %" }), "a zero-rated line is at 0%").toBeDisabled();
  await expect(dialog.getByRole("spinbutton", { name: "الضريبة %" })).toHaveValue("0");
  const reasonSelect = dialog.getByTestId("invoice-line-0-reason");
  await expect(reasonSelect, "ZATCA's reasons, in Arabic").toContainText("الخدمات التعليمية الخاصة للمواطنين");
  await expect(reasonSelect).toContainText("صادرات السلع من المملكة");
  await expect(reasonSelect, "never an exempt reason on a zero-rated line").not.toContainText("الخدمات المالية");
  if (reason) await reasonSelect.selectOption(reason);
  await fitsAtPhoneWidth(page, "the invoice dialog with a zero-rated line");
  const sent = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/invoices");
  await dialog.getByRole("button", { name: "إنشاء فاتورة" }).click();
  const body = (await sent).postDataJSON();
  await expect(dialog).toBeHidden();
  return body as { items: Array<Record<string, unknown>> };
}

async function invoiceIdByDescription(description: string): Promise<number> {
  return (await db.query(`SELECT i.id FROM invoices i JOIN invoice_items it ON it.invoice_id = i.id WHERE i.organization_id = $1 AND it.description = $2`, [orgId, description])).rows[0].id;
}

test.describe.serial("Zero-rated lines carry their reason from ZATCA's list, through the form", () => {
  test("🔴 the form sends the category and the reason chosen from ZATCA's list in Arabic; the invoice issues", async ({ browser }) => {
    const { page, close } = await open(browser, "/invoices");
    const body = await createZeroRated(page, "School tuition, term 1", "VATEX-SA-EDU");
    expect(body.items).toEqual([expect.objectContaining({ vatRate: 0, taxCategoryCode: "Z", taxExemptionReasonCode: "VATEX-SA-EDU" })]);
    await close();
    const id = await invoiceIdByDescription("School tuition, term 1");
    const stored = (await db.query(`SELECT tax_category_code, tax_exemption_reason_code, tax_exemption_reason_text FROM invoice_items WHERE invoice_id = $1`, [id])).rows[0];
    expect(stored).toEqual({ tax_category_code: "Z", tax_exemption_reason_code: "VATEX-SA-EDU", tax_exemption_reason_text: "Private education to citizen" });
    expect((await admin.post(`/api/invoices/${id}/submit`)).status()).toBe(200);
    const approved = await admin.post(`/api/invoices/${id}/approve`);
    expect(approved.status(), await approved.text()).toBe(200);
  });

  test("🔴 a zero-rated line without its reason saves as a draft, and its approval is refused with the reason in Arabic", async ({ browser }) => {
    const { page, close } = await open(browser, "/invoices");
    const body = await createZeroRated(page, "Unexplained zero-rated line", null);
    expect(body.items[0]).toMatchObject({ taxCategoryCode: "Z" });
    expect(body.items[0], "no reason was chosen, and none is invented").not.toHaveProperty("taxExemptionReasonCode");
    const id = await invoiceIdByDescription("Unexplained zero-rated line");
    expect((await admin.post(`/api/invoices/${id}/submit`)).status()).toBe(200);
    await page.goto("/approvals", { waitUntil: "networkidle" });
    await page.getByTestId(`approval-approve-invoices-${id}`).click();
    await page.getByTestId("issue-confirm-approve").click();
    await expect(page.getByText("ويحتاج سببه من قائمة هيئة الزكاة والضريبة والجمارك").first(), "the refusal, in Arabic").toBeVisible();
    await close();
    expect((await db.query(`SELECT icv, invoice_hash FROM invoices WHERE id = $1`, [id])).rows[0], "nothing issued").toEqual({ icv: null, invoice_hash: null });
  });
});
