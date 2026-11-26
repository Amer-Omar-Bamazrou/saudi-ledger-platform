import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

import { readFileSync } from "node:fs";
// the one PDF reader (the API tests' own): the file is read back, never assumed
import { readPdf } from "../../api/src/tests/helpers/pdfText";

/**
 * 🔴 19B 19.15 / 19.17 THROUGH THE PAGES — a builder report as a PDF, read back from the file the browser was given.
 *
 * This is where the rendered-file checks run in CI (the API test job has no Chromium; this one does):
 *  - an accountant (English, desktop) groups sales by customer and presses Export PDF: the downloaded file carries
 *    each subtotal and the total, and nothing is cut off at the edge of the page;
 *  - a viewer (Arabic, 390 px) exports journal lines: the file is right-to-left, its labels Arabic, the bank text
 *    is absent and marked withheld, the typed text is there;
 *  - a 130-line table runs over several pages with none lost; an empty report is one page that says so.
 *
 * (The rules are held by apps/api/src/tests/s7-report-pdf.test.ts.) 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-s7pd-${STAMP}`;
const USERS = { admin: `e2e-s7pd-adm-${STAMP}@smoke.local`, accountant: `e2e-s7pd-acc-${STAMP}@smoke.local`, viewer: `e2e-s7pd-view-${STAMP}@smoke.local` } as const;
type Role = keyof typeof USERS;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
// the business day (Asia/Riyadh): the builder's "this calendar month" starts from it
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
const REPORT = `PDF sales ${STAMP}`;
const SHOTS = process.env.S7_SHOTS_DIR;

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S7 PDF Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S7 Co','1010707109','319292929292965','1234','King Fahd Road','Al Olaya','Riyadh','12345',1,'gregorian')`, [orgId]);
  for (const role of Object.keys(USERS) as Role[]) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [USERS[role], `E2E S7 ${role}`, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    api[role] = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
    const login = await api[role].post("/api/auth/login", { data: { email: USERS[role], password: PASSWORD } });
    expect(login.ok(), `login ${role}: ${login.status()}`).toBeTruthy();
    expect((await api[role].post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  const post = async (path: string, data: unknown, status = 200) => {
    const r = await api.admin.post(path, { data });
    expect(r.status(), `${path}: ${await r.text()}`).toBe(status);
    return r.json();
  };
  for (const [name, prices] of [["عميل أول", [1000, 33.33]], ["Second customer", [400.2]]] as const) {
    const customer = await post("/api/customers", { name }, 201);
    for (const unitPrice of prices) {
      const inv = await post("/api/invoices", { date: TODAY, dueDate: TODAY, customerId: customer.id, items: [{ description: "خدمة", quantity: 1, unitPrice, vatRate: 15 }] }, 201);
      await post(`/api/invoices/${inv.id}/submit`, {});
      await post(`/api/invoices/${inv.id}/approve`, {});
    }
  }
  const acct = async (code: string) => (await db.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
  const [rent, accrued] = [await acct("RENT_UTILITIES"), await acct("ACCRUED_LIABILITIES")];
  const bank = await post("/api/bank-accounts", { name: "S7 Ops", bankName: "SNB", currency: "SAR" }, 201);
  // a bank line (the bank's own text) and a typed entry, today
  await post("/api/transactions", { date: TODAY, description: BANK_TEXT, amount: 120, currency: "SAR", type: "debit", categoryId: rent, bankAccountId: bank.id }, 201);
  const typed = await post("/api/journal-entries", { date: TODAY, description: TYPED_TEXT, lines: [
    { accountId: rent, accountName: "Rent & Utilities", debitAmount: 50, creditAmount: 0, description: TYPED_TEXT },
    { accountId: accrued, accountName: "Accrued Liabilities", debitAmount: 0, creditAmount: 50, description: TYPED_TEXT },
  ] }, 201);
  await post(`/api/journal-entries/${typed.id}/approve`, {});
  // one entry of 130 lines, on its own day in an earlier year: a table longer than a page
  const lines = Array.from({ length: LONG }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    return i % 2 === 0
      ? { accountId: rent, accountName: "Rent & Utilities", debitAmount: 1, creditAmount: 0, description: `S7LONG${n}` }
      : { accountId: accrued, accountName: "Accrued Liabilities", debitAmount: 0, creditAmount: 1, description: `S7LONG${n}` };
  });
  const long = await post("/api/journal-entries", { date: LONG_DAY, description: "S7 long entry", lines }, 201);
  await post(`/api/journal-entries/${long.id}/approve`, {});
});

test.afterAll(async () => {
  for (const a of Object.values(api)) await a?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function pageAs(browser: Browser, role: Role, path: string, lang: "ar" | "en", viewport: { width: number; height: number }): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api[role].storageState(), viewport });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  return { page, close: () => ctx.close() };
}

/** A click tied to the request it must send: a click that sends nothing fails here, by name. */
async function clickAndAnswer(page: Page, testId: string, method: string, path: RegExp, status: number) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === method && path.test(new URL(r.url()).pathname)),
    page.getByTestId(testId).click(),
  ]);
  expect(response.status(), `${testId} → ${response.url()}`).toBe(status);
}

const BANK_TEXT = "S7 BANK SARIE TRANSFER REF 7719";
const TYPED_TEXT = "S7 typed accrual";
const LONG = 130;
const LONG_DAY = `${Number(TODAY.slice(0, 4)) - 1}-03-15`;

/** Presses a builder export button and reads the file the browser was given. */
async function downloaded(page: Page, testId: string) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId(testId).click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const path = await download.path();
  const buf = readFileSync(path!);
  expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  return readPdf(buf);
}
/** A dataset PDF straight from the route, as a signed-in role. */
async function fetched(role: Role, path: string) {
  const r = await api[role].get(path);
  expect(r.status(), path).toBe(200);
  expect(r.headers()["content-type"]).toMatch(/^application\/pdf/);
  return readPdf(await r.body());
}

test.describe.serial("19B 19.15 — a builder report as a PDF", () => {
  test("🔴 accountant (English, desktop): Export PDF of a grouped sales report — the subtotals and the total are in the file, and nothing is cut off", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "accountant", "/reports/builder", "en", DESKTOP);
    await page.getByTestId("builder-dataset").selectOption("sales_documents");
    for (const key of ["customerName", "documentNumber", "signedTotal"]) await page.getByTestId(`builder-add-${key}`).click();
    await page.getByTestId("builder-group").selectOption("customerName");
    await expect(page.getByTestId("builder-export-pdf")).toBeDisabled(); // nothing run yet: nothing to export
    await clickAndAnswer(page, "builder-run", "GET", /^\/api\/reports\/datasets\/sales_documents\/rows$/, 200);
    const pdf = await downloaded(page, "builder-export-pdf");
    expect(pdf.pages).toBe(1);
    expect(pdf.has("Sales documents")).toBe(true);
    expect(pdf.has("E2E S7 Co")).toBe(true);
    expect(pdf.has("Subtotal: Second customer (1)")).toBe(true);
    for (const figure of ["460.23", "1,188.33", "1,648.56"]) expect([figure, pdf.has(figure)]).toEqual([figure, true]);
    expect(pdf.has("Total (3)")).toBe(true);
    expect(pdf.offPage()).toEqual([]);
    // the same figures the screen shows
    await expect(page.getByTestId("builder-groups-grand")).toContainText("1,648.56");
    await close();
  });

  test("🔴 viewer (Arabic, 390 px): the PDF is right-to-left with Arabic labels; the bank text is absent and marked withheld; the typed text is there", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "viewer", "/reports/builder", "ar", PHONE);
    await page.getByTestId("builder-dataset").selectOption("journal_lines");
    for (const key of ["date", "entryNumber", "description", "debit"]) await page.getByTestId(`builder-add-${key}`).click();
    await clickAndAnswer(page, "builder-run", "GET", /^\/api\/reports\/datasets\/journal_lines\/rows$/, 200);
    await expect(page.getByTestId("builder-export-pdf")).toHaveText("تصدير PDF");
    await fitsAtPhoneWidth(page, "the builder with both export buttons");
    const pdf = await downloaded(page, "builder-export-pdf");
    expect(pdf.has("سطور القيود")).toBe(true);
    expect(pdf.has("Journal lines")).toBe(false);
    const [first, last] = [pdf.xOf("التاريخ", 1), pdf.xOf("مدين", 1)];
    expect(first != null && last != null, `${first} ${last}`).toBe(true);
    expect(first!).toBeGreaterThan(last!); // the first column sits to the right
    expect(pdf.has(BANK_TEXT)).toBe(false);
    expect(pdf.has("SARIE")).toBe(false);
    expect(pdf.has("محجوب")).toBe(true);
    expect(pdf.has(TYPED_TEXT)).toBe(true);
    expect(/[٠-٩۰-۹]/.test(pdf.text)).toBe(false); // Latin digits
    expect(pdf.offPage()).toEqual([]);
    // the accountant file of the same report HAS the bank text (the absence above is not an empty file)
    const acc = await fetched("accountant", `/api/reports/datasets/journal_lines/export?format=pdf&lang=ar&date_from=${TODAY}&date_to=${TODAY}&columns=date,entryNumber,description,debit`);
    expect(acc.has(BANK_TEXT)).toBe(true);
    await close();
  });

  test("🔴 a 130-line table runs over several pages with none lost and the header on each; an empty report is one page that says so", async () => {
    const long = await fetched("accountant", `/api/reports/datasets/journal_lines/export?format=pdf&date_from=${LONG_DAY}&date_to=${LONG_DAY}&columns=date,entryNumber,description,debit,credit`);
    expect(long.pages).toBeGreaterThan(2);
    for (let i = 1; i <= LONG; i++) {
      const tag = `S7LONG${String(i).padStart(3, "0")}`;
      expect([tag, long.count(tag)]).toEqual([tag, 1]);
    }
    for (let p = 1; p <= long.pages; p++) expect([p, long.xOf("Line text", p) != null]).toEqual([p, true]);
    const empty = await fetched("accountant", "/api/reports/datasets/sales_documents/export?format=pdf&date_from=2020-01-01&date_to=2020-01-31");
    expect(empty.pages).toBe(1);
    expect(empty.has("Nothing in this period.")).toBe(true);
  });
});
