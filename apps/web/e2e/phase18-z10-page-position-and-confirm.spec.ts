import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Locator, type Page } from "./fixtures";

/**
 * 🔴 Phase 18 final round: what the re-walk found (2026-11-05), register §11.151, in Arabic:
 *  N-1 "The page jumping to the top ... Fix it if it comes from the app." It does: a form opened from a row, closed or saved,
 *      returned focus to the page's "new" button at the top, and the page scrolled there.
 *  N-2 "The new confirmation on a deposit's advance tax invoice and its credit note must name the document and the amount
 *      being issued." It named a number, and warned on a credit note that corrections are made with a credit note.
 *  N-4 A link followed from far down a page opened the next page partway down, past what it was opened to show.
 *  N-5 The Arabic date picker's weekday headings ran together at phone width.
 *
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 600 };
const STAMP = Date.now();
const SLUG = `e2e-z10-${STAMP}`;
const ADMIN = `e2e-z10-admin-${STAMP}@smoke.local`;
const CUSTOMER = `Z10 Customer ${STAMP}`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const TODAY = new Date().toISOString().slice(0, 10);

let db: Db;
let api: APIRequestContext;
let customerId = 0;
let bankId = 0;
let lastDraftId = 0;
let waitingId = 0;

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

const invoiceBody = (invoiceNumber: string) => ({ data: { invoiceNumber, date: TODAY, dueDate: TODAY, customerId, items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] } });

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Z10 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Z10 Co','1010404040','300000000000003',1,'gregorian')`, [orgId]);
  const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E Z10 Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, id]);
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  customerId = (await ok<{ id: number }>(api.post("/api/customers", { data: { name: CUSTOMER } }), "customer")).id;
  bankId = (await ok<{ id: number }>(api.post("/api/bank-accounts", { data: { name: "Z10 Bank", bankName: "SNB", currency: "SAR", isDefault: true } }), "bank")).id;
  // Enough rows that the last one is well below the fold on a phone and on a short desktop window.
  for (let i = 1; i <= 8; i += 1) {
    lastDraftId = (await ok<{ id: number }>(api.post("/api/invoices", invoiceBody(`Z10-DRAFT-${STAMP}-${i}`)), `draft ${i}`)).id;
  }
  waitingId = (await ok<{ id: number }>(api.post("/api/invoices", invoiceBody(`Z10-WAIT-${STAMP}`)), "waiting")).id;
  await ok(api.post(`/api/invoices/${waitingId}/submit`, { data: {} }), "submit");
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await api?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function arabic(browser: Browser, path: string, viewport = PHONE): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport });
  const page = await ctx.newPage();
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));
const rowOf = (page: Page, id: number): Locator => page.locator("tr").filter({ has: page.getByTestId(`invoice-open-${id}`) });

/** Brings the row's Edit button into view by scrolling the page, and returns where the page came to rest. */
async function scrollToEdit(page: Page, id: number): Promise<{ edit: Locator; at: number }> {
  const edit = rowOf(page, id).getByRole("button", { name: "تعديل", exact: true });
  await edit.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(150);
  const at = await scrollY(page);
  expect(at, "the page must really be scrolled, or this proves nothing").toBeGreaterThan(200);
  return { edit, at };
}

/** Settled means it has stopped moving: the jump happens on the frame after the dialog unmounts. */
async function expectStaysAt(page: Page, at: number) {
  await page.waitForTimeout(300);
  await expect.poll(() => scrollY(page), { message: `the page stays where it was (${at})` }).toBeGreaterThan(at - 40);
  expect(await scrollY(page)).toBeLessThan(at + 40);
}

for (const [name, viewport] of [["at phone width", PHONE], ["in a normal window", DESKTOP]] as const) {
  test.describe(`N-1 ${name}: a form opened from a row does not move the page`, () => {
    test("🔴 closing it leaves the page where it was, with focus back on the row's button", async ({ browser }) => {
      const { page, close } = await arabic(browser, "/invoices", viewport);
      const { edit, at } = await scrollToEdit(page, lastDraftId);
      await edit.click();
      const form = page.getByRole("dialog");
      await expect(form).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(form).toHaveCount(0);
      await expectStaysAt(page, at);
      await expect(edit, "focus returns to what opened it").toBeFocused();
      await close();
    });

    test("🔴 saving it leaves the page where it was", async ({ browser }) => {
      const { page, close } = await arabic(browser, "/invoices", viewport);
      const { edit, at } = await scrollToEdit(page, lastDraftId);
      await edit.click();
      const form = page.getByRole("dialog");
      await form.getByRole("button", { name: "حفظ التعديلات" }).click();
      await expect(form).toHaveCount(0);
      await expectStaysAt(page, at);
      await close();
    });
  });
}

test("🔴 N-1 the form opened from the page's own button still returns focus to that button", async ({ browser }) => {
  const { page, close } = await arabic(browser, "/invoices");
  const opener = page.getByRole("button", { name: "فاتورة جديدة" });
  await opener.click();
  const form = page.getByRole("dialog");
  await expect(form).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await expect(opener).toBeFocused();
  await close();
});

test("🔴 N-4 a link followed from far down a page opens the next page at its top, and going back returns to where you were", async ({ browser }) => {
  const { page, close } = await arabic(browser, "/invoices");
  const link = page.getByTestId(`where-approve-invoice-${waitingId}`);
  await link.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(150);
  const at = await scrollY(page);
  await link.click();
  await expect(page).toHaveURL(/\/approvals$/);
  await expect(page.getByTestId(`approval-approve-invoices-${waitingId}`)).toBeVisible();
  await expect.poll(() => scrollY(page), { message: "the new page opens at its top" }).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/invoices$/);
  await expect(page.getByTestId(`where-approve-invoice-${waitingId}`)).toBeVisible();
  if (at > 200) await expect.poll(() => scrollY(page), { message: "going back is not a new page", timeout: 5_000 }).toBeGreaterThan(100);
  await close();
});

test.describe("N-2 the confirmation names the document, on a deposit's advance tax invoice and its credit note", () => {
  test("🔴 each says what it is, for how much, and only what is true of it", async ({ browser }) => {
    const receipt = await ok<{ id: number }>(api.post("/api/payments", { data: { customerId, amount: 115, paidAt: TODAY, bankAccountId: bankId, reference: `Z10-RCPT-${STAMP}`, classification: "advance", vatCategory: "S" } }), "receipt");
    const advance = await ok<{ id: number; invoiceNumber: string }>(api.post(`/api/payments/${receipt.id}/advance-invoices`, { data: { amount: 115 } }), "advance");
    const { page, close } = await arabic(browser, "/payments");

    await page.getByRole("row").filter({ hasText: /115\.00/ }).first().getByRole("button").click();
    await page.getByTestId(`approve-advance-${advance.id}`).click();
    const confirm = page.getByTestId("issue-confirm-dialog");
    await expect(confirm).toBeVisible();
    await expect(confirm, "it is an advance tax invoice").toContainText("فاتورة ضريبية عن دفعة مقدمة");
    await expect(confirm).toContainText(advance.invoiceNumber);
    await expect(confirm).toContainText("115.00");
    await expect(confirm).toContainText(CUSTOMER);
    await expect(confirm, "issuing is final").toContainText("الإصدار نهائي");
    await expect(confirm, "and a credit note corrects it").toContainText("بإشعار دائن");
    await page.getByTestId("issue-confirm-approve").click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId(`advance-invoice-${advance.id}`)).toHaveAttribute("data-status", "sent");

    const note = await ok<{ id: number; invoiceNumber: string }>(api.post(`/api/invoices/${advance.id}/advance-credit-notes`, { data: { amount: 115, reason: "Z10" } }), "credit note");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("row").filter({ hasText: /115\.00/ }).first().getByRole("button").click();
    await page.getByTestId(`approve-advance-credit-note-${note.id}`).click();
    await expect(confirm).toBeVisible();
    await expect(confirm, "it is a credit note").toContainText("إشعار دائن");
    await expect(confirm).toContainText(note.invoiceNumber);
    await expect(confirm, "and it names the advance it cancels").toContainText(advance.invoiceNumber);
    await expect(confirm).toContainText("115.00");
    await expect(confirm, "issuing is final").toContainText("الإصدار نهائي");
    await expect(confirm, "a credit note is not told it is corrected by a credit note").not.toContainText("يكون التصحيح بإشعار دائن");
    await expect(confirm, "and it is not called an invoice").not.toContainText("تعديل الفاتورة");
    await close();
  });

  test("🔴 an ordinary invoice keeps the owner's wording", async ({ browser }) => {
    const { page, close } = await arabic(browser, "/approvals");
    await page.getByTestId(`approval-approve-invoices-${waitingId}`).click();
    const confirm = page.getByTestId("issue-confirm-dialog");
    await expect(confirm).toContainText(`Z10-WAIT-${STAMP}`);
    await expect(confirm).toContainText(CUSTOMER);
    await expect(confirm).toContainText("1,150.00");
    await expect(confirm).toContainText("الإصدار نهائي. لا يمكن تعديل الفاتورة بعد ذلك، ويكون التصحيح بإشعار دائن.");
    await page.getByTestId("issue-confirm-cancel").click();
    await close();
  });
});

test("🔴 N-5 the date picker's weekday headings stand apart at phone width", async ({ browser }) => {
  const { page, close } = await arabic(browser, "/invoices");
  await page.getByRole("button", { name: "فاتورة جديدة" }).click();
  await page.getByRole("dialog").locator("[data-date-picker=date]").first().click();
  const headings = page.locator("[data-date-picker-panel=date] th");
  await expect(headings).toHaveCount(7);
  const boxes = await headings.evaluateAll((cells) => cells.map((c) => {
    const range = document.createRange();
    range.selectNodeContents(c);
    const r = range.getBoundingClientRect();
    return { left: r.left, right: r.right, text: c.textContent ?? "", label: c.getAttribute("aria-label") ?? "" };
  }));
  const byPosition = [...boxes].sort((a, b) => a.left - b.left);
  for (let i = 1; i < byPosition.length; i += 1) {
    expect(byPosition[i]!.left - byPosition[i - 1]!.right, `"${byPosition[i - 1]!.text}" and "${byPosition[i]!.text}" must not touch`).toBeGreaterThanOrEqual(2);
  }
  for (const b of boxes) expect(b.label.length, "the full name stays for a screen reader").toBeGreaterThan(1);
  await close();
});
