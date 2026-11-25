import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 L3 THROUGH THE PAGE (owner, 2026-11-25): the Findings page RENDERS the new finding — a bill still unpaid twelve
 * months after the month following its supply — in English and in Arabic (390 px), from a bill the product's own path
 * posted and a run the page's own request triggers. The words carry the facts: the bill, what is unpaid, the VAT on it,
 * the return period, and that nothing was posted. (The detection itself: apps/api/src/tests/l3-input-vat-nonpayment.test.ts.)
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-l3find-${STAMP}`;
const ADMIN = `e2e-l3find-adm-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const VENDOR = "مورد قديم";

let db: Db;
let api: APIRequestContext;
let billNumber = "";

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E L3 Finding Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, fiscal_year_start, fiscal_calendar, vat_tax_period) VALUES ($1,'E2E L3 Co','1010707076','319292929292973','1234','King Fahd Road','Al Olaya','Riyadh','12345',1,'gregorian','monthly')`, [orgId]);
  const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E L3 admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, id]);
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
  const login = await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } });
  expect(login.ok(), `login: ${login.status()}`).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  const post = async (path: string, data: unknown, status = 200) => {
    const r = await api.post(path, { data });
    expect(r.status(), `${path}: ${await r.text()}`).toBe(status);
    return r.json();
  };
  const vendor = await post("/api/vendors", { name: VENDOR, taxNumber: "300000000000003" }, 201);
  // supplied September 2024: its twelve months after the following month ended with October 2025
  const bill = await post("/api/bills", { date: "2024-09-10", vendorId: vendor.id, vendorReference: "L3-E2E-1", supplierDocumentKind: "tax_invoice", subtotal: 1000, vatAmount: 150, total: 1150, items: [] }, 201);
  await post(`/api/bills/${bill.id}/post`, {});
  billNumber = bill.billNumber;
  await post("/api/findings/run", {});
});

test.afterAll(async () => {
  await api?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function pageAs(browser: Browser, lang: "en" | "ar", viewport?: { width: number; height: number }): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api.storageState(), ...(viewport ? { viewport } : {}) });
  const page = await ctx.newPage();
  await page.goto("/findings", { waitUntil: "networkidle" });
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  return { page, close: () => ctx.close() };
}

test.describe.serial("L3 — the non-payment finding on the Findings page", () => {
  test("🔴 English: the finding is listed with the bill, the unpaid share, its VAT, the return period — and that nothing was posted", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "en");
    await expect(page.getByText("Input VAT on a bill unpaid after twelve months").first()).toBeVisible();
    const line = page.locator("p", { hasText: billNumber }).first();
    await expect(line).toContainText(`${billNumber} (${VENDOR}), supplied 2024-09-10`);
    await expect(line).toContainText("SAR 1,150.00 still unpaid twelve months after the month following the supply");
    await expect(line).toContainText("The input VAT on it, SAR 150.00, is reversed in the return for 2025-10 (VAT IR Art. 40(10))");
    await expect(line).toContainText("Nothing has been posted.");
    await close();
  });

  test("🔴 Arabic, 390 px: the same finding in Arabic, with the same figures; the page fits the phone", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "ar", PHONE);
    await expect(page.getByText("ضريبة مدخلات على فاتورة مورد غير مسددة بعد اثني عشر شهرًا").first()).toBeVisible();
    const line = page.locator("p", { hasText: billNumber }).first();
    await expect(line).toContainText(`${billNumber} (${VENDOR})، توريد 2024-09-10`);
    await expect(line).toContainText("غير مسدد بعد اثني عشر شهرًا من الشهر التالي للتوريد");
    await expect(line).toContainText("(المادة 40(10) من اللائحة)");
    await expect(line).toContainText("لم يُرحَّل شيء.");
    // the figures and the period, whatever digits the page shows them in elsewhere
    await expect(line).toContainText("2025-10");
    await fitsAtPhoneWidth(page, "the Findings page with the non-payment finding");
    await close();
  });
});
