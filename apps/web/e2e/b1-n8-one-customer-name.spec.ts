import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * 🔴 Carry-over Batch 1, N-8 (the owner, 2026-11-07; the re-walk's finding): one customer, one name per language.
 * In Arabic mode the customer's Arabic name wherever one exists, else the English; in English mode the English name,
 * else the Arabic. The same on every screen: the invoice form's picker, the list, the detail screen, the confirmation,
 * and a receipt opened from the customer's page. An ISSUED invoice reads its buyer from the snapshot taken at issue
 * (G32), never the live customer: renaming the customer afterwards changes a draft, not the issued invoice.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-n8-${STAMP}`;
const ADMIN = `e2e-n8-admin-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const TODAY = new Date().toISOString().slice(0, 10);
const EN = `N8 English Trading ${STAMP}`;
const AR = `شركة ن ثمانية ${STAMP}`;
const EN_LATER = `N8 Renamed Trading ${STAMP}`;
const AR_LATER = `شركة الاسم الجديد ${STAMP}`;

let db: Db;
let api: APIRequestContext;
let customerId = 0;
let issuedId = 0;
let draftId = 0;
let waitingId = 0;
let receiptId = 0;

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

const invoiceBody = (invoiceNumber: string) => ({ data: { invoiceNumber, date: TODAY, dueDate: TODAY, customerId, items: [{ description: "N8 work", quantity: 1, unitPrice: 1000, vatRate: 15 }] } });

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E N8 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E N8 Co','1010404040','300000000000003',1,'gregorian')`, [orgId]);
  const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E N8 Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, id]);
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  customerId = (await ok<{ id: number }>(api.post("/api/customers", { data: { name: EN, nameAr: AR } }), "customer")).id;
  const bankId = (await ok<{ id: number }>(api.post("/api/bank-accounts", { data: { name: "N8 Bank", bankName: "SNB", currency: "SAR", isDefault: true } }), "bank")).id;
  issuedId = (await ok<{ id: number }>(api.post("/api/invoices", invoiceBody(`N8-ISSUED-${STAMP}`)), "to issue")).id;
  await ok(api.post(`/api/invoices/${issuedId}/approve`), "issue");
  draftId = (await ok<{ id: number }>(api.post("/api/invoices", invoiceBody(`N8-DRAFT-${STAMP}`)), "draft")).id;
  waitingId = (await ok<{ id: number }>(api.post("/api/invoices", invoiceBody(`N8-WAIT-${STAMP}`)), "waiting")).id;
  await ok(api.post(`/api/invoices/${waitingId}/submit`, { data: {} }), "submit");
  receiptId = (await ok<{ id: number }>(api.post("/api/payments", { data: { customerId, amount: 115, paidAt: TODAY, bankAccountId: bankId, reference: `N8-RCPT-${STAMP}`, classification: "advance", vatCategory: "S" } }), "receipt")).id;
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await api?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function open(browser: Browser, lang: "ar" | "en", path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport: lang === "ar" ? PHONE : DESKTOP });
  await ctx.addInitScript((l) => { try { localStorage.setItem("ksa_lang", l); } catch { /* the default language */ } }, lang);
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  return { page, close: () => ctx.close() };
}

const rowOf = (page: Page, id: number) => page.locator("tr").filter({ has: page.getByTestId(`invoice-open-${id}`) });

test.describe.serial("N-8: one customer, one name per language", () => {
  for (const [lang, shown, hidden] of [["ar", AR, EN], ["en", EN, AR]] as const) {
    test(`🔴 ${lang}: the invoice list, the detail screen and the confirmation show the ${lang === "ar" ? "Arabic" : "English"} name only`, async ({ browser }) => {
      const { page, close } = await open(browser, lang, "/invoices");
      for (const id of [issuedId, draftId]) {
        await expect(rowOf(page, id), `list row ${id}`).toContainText(shown);
        await expect(rowOf(page, id), `list row ${id}`).not.toContainText(hidden);
      }
      await page.goto(`/invoices/${issuedId}`, { waitUntil: "networkidle" });
      const detail = page.getByTestId("invoice-detail");
      await expect(detail).toContainText(shown);
      await expect(detail).not.toContainText(hidden);
      await page.goto("/approvals", { waitUntil: "networkidle" });
      await page.getByTestId(`approval-approve-invoices-${waitingId}`).click();
      const confirm = page.getByTestId("issue-confirm-dialog");
      await expect(confirm).toContainText(shown);
      await expect(confirm).not.toContainText(hidden);
      await page.getByTestId("issue-confirm-cancel").click();
      await close();
    });

    test(`🔴 ${lang}: the invoice form's customer picker offers the ${lang === "ar" ? "Arabic" : "English"} name`, async ({ browser }) => {
      const { page, close } = await open(browser, lang, "/invoices");
      await page.getByRole("button", { name: lang === "ar" ? "فاتورة جديدة" : "New Invoice" }).click();
      const form = page.getByRole("dialog");
      await form.getByRole("combobox").filter({ hasText: lang === "ar" ? "اختر العميل" : "Select customer" }).click();
      await expect(page.getByRole("option", { name: shown })).toBeVisible();
      await expect(page.getByRole("option", { name: hidden })).toHaveCount(0);
      await close();
    });

    test(`🔴 ${lang}: a receipt opened from the customer's page names the customer in ${lang === "ar" ? "Arabic" : "English"}`, async ({ browser }) => {
      const { page, close } = await open(browser, lang, `/customers/${customerId}`);
      await page.getByTestId(`payment-toggle-${receiptId}`).click();
      const detail = page.getByTestId(`payment-detail-${receiptId}`);
      await expect(detail).toContainText(shown);
      await expect(detail).not.toContainText(hidden);
      await close();
    });
  }

  test("🔴 an issued invoice keeps the names it was issued with; a draft follows the customer", async ({ browser }) => {
    await ok(api.patch(`/api/customers/${customerId}`, { data: { name: EN_LATER, nameAr: AR_LATER } }), "rename");
    for (const [lang, issuedName, draftName] of [["ar", AR, AR_LATER], ["en", EN, EN_LATER]] as const) {
      const { page, close } = await open(browser, lang, "/invoices");
      await expect(rowOf(page, issuedId), "the issued invoice, in the list").toContainText(issuedName);
      await expect(rowOf(page, draftId), "the draft, in the list").toContainText(draftName);
      await page.goto(`/invoices/${issuedId}`, { waitUntil: "networkidle" });
      await expect(page.getByTestId("invoice-detail"), "the issued invoice's detail").toContainText(issuedName);
      await close();
    }
  });
});
