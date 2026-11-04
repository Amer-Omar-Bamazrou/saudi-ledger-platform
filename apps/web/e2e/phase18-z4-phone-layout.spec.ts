import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Locator, type Page } from "./fixtures";

/**
 * 🔴 Phase 18 final round (owner, 2026-11-04), the walk's phone-width findings, register §11.137. In Arabic at 390 px:
 *  1. New invoice: the VAT field shows its whole value, and no line field is cut off.
 *  2. Invoice list: the Amount column is never clipped.
 *  3. VAT return: the period filter fits the screen.
 *  7. The bank card's balance stays inside the card.
 *  8. The approvals table's buttons are not clipped.
 *  9. Dropdowns are mirrored for Arabic.
 * Each is measured from the rendered page: a real value, its real box, against the screen or the box that must hold it.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-z4-${STAMP}`;
const ADMIN = `e2e-z4-admin-${STAMP}@smoke.local`;
const KEEPER = `e2e-z4-keeper-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const LINE_FIELDS = ["الوصف", "الوصف بالعربية", "الكمية", "سعر الوحدة", "الضريبة %"];

let db: Db;
let adminApi: APIRequestContext;
let keeperApi: APIRequestContext;
let invoiceId = 0;

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Z4 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Z4 Co',1,'gregorian')`, [orgId]);
  for (const [email, name, role] of [[ADMIN, "E2E Z4 Admin", "admin"], [KEEPER, "E2E Z4 Keeper", "bookkeeper"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
  }
  adminApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  keeperApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  for (const [api, email] of [[adminApi, ADMIN], [keeperApi, KEEPER]] as const) {
    expect((await api.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
    expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  const customer = (await ok<{ id: number }>(adminApi.post("/api/customers", { data: { name: `Z4 Customer ${STAMP}` } }), "customer")).id;
  const vendor = (await ok<{ id: number }>(adminApi.post("/api/vendors", { data: { name: `Z4 Supplier ${STAMP}`, residency: "resident" } }), "vendor")).id;
  const bank = (await ok<{ id: number }>(adminApi.post("/api/bank-accounts", { data: { name: "Z4 Long Bank Account Name", bankName: "Saudi National Bank", currency: "SAR" } }), "bank")).id;
  // A long ledger balance: the figure that must stay inside its card.
  await ok(adminApi.post("/api/supplier-payments", { data: { vendorId: vendor, bankAccountId: bank, amount: 1234567.89, paidAt: "2026-10-05", classification: "unknown" } }), "payment");
  // A bookkeeper's invoice waiting in the admin's approvals, so all its buttons show.
  invoiceId = (await ok<{ id: number }>(keeperApi.post("/api/invoices", { data: { invoiceNumber: `Z4-INV-${STAMP}`, date: "2026-10-05", dueDate: "2026-10-31", customerId: customer,
    items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] } }), "invoice")).id;
  await ok(keeperApi.post(`/api/invoices/${invoiceId}/submit`, { data: {} }), "submit");
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
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

/** The element's whole box lies on the screen: nothing of it is past either edge, or clipped by a scrolling parent. */
async function expectOnScreen(loc: Locator, what: string) {
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, screen: document.documentElement.clientWidth };
  });
  expect(box.left, `${what}: past the screen's left edge`).toBeGreaterThanOrEqual(0);
  expect(box.right, `${what}: past the screen's right edge`).toBeLessThanOrEqual(box.screen);
}

/** The text a field shows (its value, or its placeholder when empty) fits the room inside the field. */
async function expectFits(input: Locator, what: string) {
  const m = await input.evaluate((el) => {
    const i = el as HTMLInputElement;
    const cs = getComputedStyle(i);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    // The browser's number stepper takes room from the text where it is drawn.
    const stepper = i.type === "number" && getComputedStyle(i, "::-webkit-inner-spin-button").appearance !== "none" ? 16 : 0;
    return { room: i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - stepper, need: ctx.measureText(i.value || i.placeholder).width, text: i.value || i.placeholder };
  });
  expect(m.need, `${what}: "${m.text}" needs ${m.need}px of ${m.room}px`).toBeLessThanOrEqual(m.room);
}

test.describe("phone width, in Arabic", () => {
  test("🔴 1. new invoice: each line field shows all it holds, the VAT rate included", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/invoices");
    await page.getByRole("button", { name: "فاتورة جديدة" }).click();
    for (const name of LINE_FIELDS) {
      const field = page.getByPlaceholder(name, { exact: true }).first();
      await expectOnScreen(field, name);
      await expectFits(field, `${name}, empty`);
    }
    const values: Array<[string, string]> = [["الوصف", "Consulting"], ["الوصف بالعربية", "استشارات"], ["الكمية", "12"], ["سعر الوحدة", "12500.50"], ["الضريبة %", "15"]];
    for (const [name, value] of values) {
      const field = page.getByPlaceholder(name, { exact: true }).first();
      await field.fill(value);
      await expect(field).toHaveValue(value);
      await expectFits(field, `${name}, filled`);
    }
    await close();
  });

  test("🔴 2. invoice list: the amount, the VAT and the total are all on screen", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/invoices");
    const row = page.locator("tbody tr", { hasText: `Z4-INV-${STAMP}` });
    await expect(row).toBeVisible();
    await expectOnScreen(row.locator("td", { hasText: /^(المبلغ)?\s*1,000\.00$/ }).first(), "the amount");
    await expectOnScreen(row.locator("td", { hasText: /^(ضريبة القيمة المضافة)?\s*150\.00$/ }).first(), "the VAT");
    await expectOnScreen(row.locator("td", { hasText: /^(الإجمالي)?\s*1,150\.00$/ }).first(), "the total");
    await close();
  });

  test("🔴 3. VAT return: the period filter and its shortcuts fit the screen, and the title is not squeezed", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/vat");
    await expectOnScreen(page.getByTestId("vat-period-from"), "period from");
    await expectOnScreen(page.getByTestId("vat-period-to"), "period to");
    const shortcuts = page.getByRole("group", { name: /اختصار/ }).first();
    await expectOnScreen(shortcuts, "the period shortcuts");
    for (const b of await shortcuts.getByRole("button").all()) await expectOnScreen(b, `shortcut ${await b.textContent()}`);
    const title = await page.locator("h1").first().evaluate((el) => el.getBoundingClientRect().width);
    expect(title, "the title has the screen's width to use").toBeGreaterThan(250);
    await close();
  });

  test("🔴 7. bank card: the balance stays inside the card", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/bank-accounts");
    const balance = page.getByTestId("ledger-balance").locator("div", { hasText: "1,234,567.89" }).last();
    await expect(balance).toBeVisible();
    const m = await balance.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const card = el.closest("[data-row]")!.getBoundingClientRect();
      return { text: [text.left, text.right], card: [card.left, card.right] };
    });
    expect(m.text[0], "past the card's left edge").toBeGreaterThanOrEqual(m.card[0]);
    expect(m.text[1], "past the card's right edge").toBeLessThanOrEqual(m.card[1]);
    await expectOnScreen(page.locator("[data-row]").first(), "the card");
    await close();
  });

  test("🔴 8. approvals: every button is on screen with its whole label", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/approvals");
    for (const action of ["approve", "send-back", "reject"]) {
      const button = page.getByTestId(`approval-${action}-invoices-${invoiceId}`);
      await expect(button).toBeVisible();
      await expectOnScreen(button, action);
      const clipped = await button.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(clipped, `${action}: its label fits`).toBe(false);
    }
    await close();
  });

  test("🔴 9. a dropdown is mirrored: its text at the start, the arrow at the end, and its options read right to left", async ({ browser }) => {
    const { page, close } = await arabicPhone(browser, "/invoices");
    await page.getByRole("button", { name: "فاتورة جديدة" }).click();
    const trigger = page.getByRole("dialog").getByRole("combobox").first();
    await expect(trigger).toBeVisible();
    const layout = await trigger.evaluate((el) => {
      const arrow = el.querySelector("svg")!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { direction: getComputedStyle(el).direction, arrowFromLeft: arrow.left - box.left, arrowFromRight: box.right - arrow.right };
    });
    expect(layout.direction).toBe("rtl");
    expect(layout.arrowFromLeft, "the arrow is at the left, the end in Arabic").toBeLessThan(layout.arrowFromRight);
    await trigger.click();
    const option = page.getByRole("option", { name: `Z4 Customer ${STAMP}` });
    await expect(option).toBeVisible();
    expect(await option.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
    const text = await option.evaluate((el) => {
      const label = el.querySelector("span:not(.absolute)")!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { fromLeft: label.left - box.left, fromRight: box.right - label.right };
    });
    expect(text.fromRight, "the option's text starts at the right").toBeLessThan(text.fromLeft);
    await close();
  });
});
