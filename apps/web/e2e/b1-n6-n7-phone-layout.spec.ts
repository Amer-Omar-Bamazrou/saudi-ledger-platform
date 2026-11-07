import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Locator, type Page } from "./fixtures";

/**
 * 🔴 Carry-over Batch 1, N-6 and N-7 (the owner, 2026-11-07; the re-walk's findings), in Arabic at 390 px:
 *  - N-6: a receipt's detail, once a credit note exists against its advance tax invoice: the note's issue button is
 *    reachable without leaving the screen, and the dialog does not scroll sideways.
 *  - N-7: Payments and Customers need no sideways page scrolling: the row's own action is on screen as loaded, and
 *    the receipt number stays on one line.
 * "On screen" is measured: the control's box lies inside the 390 px viewport as the page loads, before any scrolling.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-n67-${STAMP}`;
const ADMIN = `e2e-n67-admin-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const TODAY = new Date().toISOString().slice(0, 10);
const CUSTOMER_EN = `N67 Phone Layout Trading ${STAMP}`;
const CUSTOMER_AR = `شركة اختبار عرض الهاتف ${STAMP}`;
const REFERENCE = `N67-RCPT-${STAMP}`;

let db: Db;
let api: APIRequestContext;
let customerId = 0;
let receiptId = 0;
let noteId = 0;

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E N67 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E N67 Co','1010404040','300000000000003',1,'gregorian')`, [orgId]);
  const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E N67 Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, id]);
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  customerId = (await ok<{ id: number }>(api.post("/api/customers", { data: { name: CUSTOMER_EN, nameAr: CUSTOMER_AR } }), "customer")).id;
  const bankId = (await ok<{ id: number }>(api.post("/api/bank-accounts", { data: { name: "N67 Bank", bankName: "SNB", currency: "SAR", isDefault: true } }), "bank")).id;
  receiptId = (await ok<{ id: number }>(api.post("/api/payments", { data: { customerId, amount: 115, paidAt: TODAY, bankAccountId: bankId, reference: REFERENCE, classification: "advance", vatCategory: "S" } }), "receipt")).id;
  const advance = await ok<{ id: number }>(api.post(`/api/payments/${receiptId}/advance-invoices`, { data: { amount: 115 } }), "advance invoice");
  await ok(api.post(`/api/invoices/${advance.id}/approve`), "issue the advance invoice");
  noteId = (await ok<{ id: number }>(api.post(`/api/invoices/${advance.id}/advance-credit-notes`, { data: { amount: 115, reason: "N67" } }), "credit note")).id;
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
  await ctx.addInitScript(() => { try { localStorage.setItem("ksa_lang", "ar"); } catch { /* the default language */ } });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

/** The control lies wholly inside the 390 px viewport, as loaded: no sideways scroll needed to reach it. */
async function onScreen(control: Locator, what: string) {
  await expect(control, what).toBeVisible();
  const box = await control.boundingBox();
  expect(box, `${what}: has a box`).not.toBeNull();
  expect(box!.x, `${what}: starts inside the screen (x=${box!.x})`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what}: ends inside the screen (right=${box!.x + box!.width})`).toBeLessThanOrEqual(PHONE.width);
}

/** The page itself does not scroll sideways. */
async function noSidewaysPage(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where}: the page scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
}

test.describe("N-6, N-7: phone layout at 390 px", () => {
  test("🔴 N-7 Payments: no sideways page scroll, the Details action is on screen, and the receipt number stays on one line", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/payments");
    await noSidewaysPage(page, "Payments");
    await onScreen(page.getByTestId(`payment-open-${receiptId}`), "the receipt's Details action");
    // The row's first cell is the receipt number (`receiptNumber(p.id)`).
    const number = page.getByTestId(`payment-row-${receiptId}`).locator("td").first();
    const lines = await number.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
    });
    expect(lines, "the receipt number wraps onto more than one line").toBe(1);
    await close();
  });

  test("🔴 N-7 Customers: no sideways page scroll, and the row's View action is on screen", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/customers");
    await noSidewaysPage(page, "Customers");
    const row = page.locator("tr", { hasText: CUSTOMER_AR });
    await onScreen(row.getByRole("button", { name: "عرض" }), "the customer's View action");
    await close();
  });

  test("🔴 N-6 a receipt's detail with a credit note: the note's issue action is on screen, and the dialog does not scroll sideways", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/payments");
    await page.getByTestId(`payment-open-${receiptId}`).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await onScreen(page.getByTestId(`approve-advance-credit-note-${noteId}`), "the credit note's issue action");
    const sideways = await dialog.evaluate((el) => {
      let worst = el.scrollWidth - el.clientWidth;
      for (const c of Array.from(el.querySelectorAll("*"))) {
        const s = getComputedStyle(c);
        if ((s.overflowX === "auto" || s.overflowX === "scroll") && c.scrollWidth - c.clientWidth > worst) worst = c.scrollWidth - c.clientWidth;
      }
      return worst;
    });
    expect(sideways, `the dialog or a table in it scrolls sideways by ${sideways}px`).toBeLessThanOrEqual(1);
    await close();
  });
});
