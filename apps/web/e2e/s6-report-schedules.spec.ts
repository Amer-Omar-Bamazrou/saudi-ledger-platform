import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 19B S6 THROUGH THE PAGES — scheduling a saved report, and the copies it delivers.
 *
 *  - A bookkeeper (English, desktop) schedules their saved journal-lines report for themselves and a viewer, picking
 *    from the members list — NAMES AND ROLES, never an email. The schedule is listed with its recipients.
 *  - The served API's own job delivers it (the suite runs it every few seconds). The viewer (Arabic, 390 px) finds
 *    their copy under delivered reports and opens it: the typed line's text is there; the BANK line's text is marked
 *    withheld for their role — it was never written into their copy — while the bookkeeper's copy shows it.
 *  - A viewer is offered themselves only on the schedule form, and told why.
 *
 * (The rules are held by apps/api/src/tests/s6-report-schedules-deliveries.test.ts.) 🔴 Its OWN tenant, created and
 * removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-s6sch-${STAMP}`;
const USERS = { admin: `e2e-s6sch-adm-${STAMP}@smoke.local`, bookkeeper: `e2e-s6sch-keep-${STAMP}@smoke.local`, viewer: `e2e-s6sch-view-${STAMP}@smoke.local` } as const;
type Role = keyof typeof USERS;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
const REPORT = `Lines this month ${STAMP}`;
const BANK_TEXT = `E2E S6 BANK TRANSFER ${STAMP}`;
const TYPED_TEXT = `E2E S6 typed entry ${STAMP}`;

let db: Db;
const api = {} as Record<Role, APIRequestContext>;
const userId = {} as Record<Role, number>;

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S6 Schedules Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S6 Schedules Co','1010707091','319292929292999','1234','King Fahd Road','Al Olaya','Riyadh','12345',1,'gregorian')`, [orgId]);
  for (const role of Object.keys(USERS) as Role[]) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [USERS[role], `E2E S6S ${role}`, hash])).rows[0].id;
    userId[role] = id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    api[role] = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
    const login = await api[role].post("/api/auth/login", { data: { email: USERS[role], password: PASSWORD } });
    expect(login.ok(), `login ${role}: ${login.status()}`).toBeTruthy();
    expect((await api[role].post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  const post = async (who: Role, path: string, data: unknown, status = 200) => {
    const r = await api[who].post(path, { data });
    expect(r.status(), `${path}: ${await r.text()}`).toBe(status);
    return r.json();
  };
  // the product's own rows this month: a bank line posted from a transaction, and a typed journal entry
  const accounts = (await db.query(`SELECT id, system_code FROM categories WHERE organization_id = $1 AND system_code IN ('RENT_UTILITIES','ACCRUED_LIABILITIES') AND is_posting`, [orgId])).rows;
  const acct = (code: string) => accounts.find((a) => a.system_code === code).id as number;
  const bank = await post("admin", "/api/bank-accounts", { name: "E2E S6 Ops", bankName: "SNB", currency: "SAR" }, 201);
  await post("admin", "/api/transactions", { date: TODAY, description: BANK_TEXT, amount: 120, currency: "SAR", type: "debit", categoryId: acct("RENT_UTILITIES"), bankAccountId: bank.id }, 201);
  const je = await post("admin", "/api/journal-entries", { date: TODAY, description: TYPED_TEXT, lines: [
    { accountId: acct("RENT_UTILITIES"), accountName: "Rent & Utilities", debitAmount: 50, creditAmount: 0, description: TYPED_TEXT },
    { accountId: acct("ACCRUED_LIABILITIES"), accountName: "Accrued Liabilities", debitAmount: 0, creditAmount: 50, description: TYPED_TEXT },
  ] }, 201);
  await post("admin", `/api/journal-entries/${je.id}/approve`, {});
  // the bookkeeper's saved report, and one of the viewer's own
  await post("bookkeeper", "/api/report-definitions", { name: REPORT, dataset: "journal_lines", columns: ["date", "entryNumber", "textOrigin", "description", "debit"], period: { kind: "this_month" }, filters: {}, sort: "date", groupBy: "accountId" }, 201);
  await post("viewer", "/api/report-definitions", { name: `Viewer own ${STAMP}`, dataset: "journal_lines", columns: ["date", "debit"], period: { kind: "this_month" }, filters: {}, sort: null }, 201);
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

async function clickAndAnswer(page: Page, testId: string, method: string, path: RegExp, status: number) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === method && path.test(new URL(r.url()).pathname)),
    page.getByTestId(testId).click(),
  ]);
  expect(response.status(), `${testId} → ${response.url()}`).toBe(status);
}

/** The member's delivered copy of the report, once the served API's job has run the schedule. */
async function deliveredId(role: Role): Promise<number> {
  let id = 0;
  await expect.poll(async () => {
    const items = (await (await api[role].get("/api/report-deliveries")).json()).items as { id: number; reportName: string }[];
    id = items.find((d) => d.reportName === REPORT)?.id ?? 0;
    return id;
  }, { timeout: 60_000, message: `no copy of "${REPORT}" was delivered to the ${role}` }).toBeGreaterThan(0);
  return id;
}

test.describe.serial("19B S6 — report schedules and delivered copies", () => {
  test("🔴 bookkeeper (English, desktop): schedules a saved report for themselves and a viewer, picked by name and role", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "bookkeeper", "/reports/saved", "en", DESKTOP);
    const item = page.getByTestId("saved-list").locator("li").filter({ hasText: REPORT });
    await item.getByRole("button", { name: "Schedule" }).click();
    const form = page.locator('[data-testid^="schedule-form-"]');
    await expect(form).toBeVisible();
    // the picker: every active member by name and role — and no email anywhere on the form
    await expect(form).toContainText("E2E S6S viewer · Viewer");
    await expect(form).toContainText("E2E S6S admin · Admin");
    await expect(form).toContainText("E2E S6S bookkeeper (you) · Bookkeeper");
    await expect(form).not.toContainText("@smoke.local");
    await expect(page.getByTestId(`schedule-recipient-${userId.bookkeeper}`)).toBeChecked();
    await page.getByTestId(`schedule-recipient-${userId.viewer}`).check();
    await form.locator("select").selectOption("daily");
    const submit = form.getByRole("button", { name: "Schedule" });
    const [created] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/report-schedules"),
      submit.click(),
    ]);
    expect(created.status()).toBe(201);
    const listed = page.getByTestId("schedules-list").locator("li").filter({ hasText: REPORT });
    await expect(listed).toContainText("Every business day");
    await expect(listed).toContainText("E2E S6S bookkeeper (Bookkeeper)");
    await expect(listed).toContainText("E2E S6S viewer (Viewer)");
    await expect(page.getByTestId("saved-reports-page")).not.toContainText("@smoke.local");

    // the bookkeeper's own copy, delivered by the served API's job, shows the bank's text
    const id = await deliveredId("bookkeeper");
    await page.goto("/reports/deliveries", { waitUntil: "networkidle" });
    await clickAndAnswer(page, `delivery-open-${id}`, "GET", /^\/api\/report-deliveries\/\d+$/, 200);
    await expect(page.getByTestId("delivery-table")).toBeVisible();
    await expect(page.getByTestId("delivery-row").filter({ hasText: BANK_TEXT })).toHaveCount(2); // the bank entry's two lines
    await expect(page.getByTestId("delivery-cell-withheld")).toHaveCount(0);
    await close();
  });

  test("🔴 viewer (Arabic, 390 px): opens their copy — the typed text is there, the bank's text is marked withheld; their own form offers themselves only", async ({ browser }) => {
    const id = await deliveredId("viewer");
    const { page, close } = await pageAs(browser, "viewer", "/reports/deliveries", "ar", PHONE);
    await expect(page.getByTestId(`delivery-item-${id}`)).toContainText(REPORT);
    await fitsAtPhoneWidth(page, "the delivered reports list");
    await clickAndAnswer(page, `delivery-open-${id}`, "GET", /^\/api\/report-deliveries\/\d+$/, 200);
    await expect(page.getByTestId("delivery-table")).toBeVisible();
    await expect(page.getByTestId("delivery-row").filter({ hasText: TYPED_TEXT })).toHaveCount(2); // presence: the typed entry's two lines
    await expect(page.getByTestId("delivery-opened")).not.toContainText(BANK_TEXT); // absence
    await expect(page.getByTestId("delivery-cell-withheld")).toHaveCount(2); // and it is marked where it would be: the bank entry's two lines
    await expect(page.getByTestId("delivery-col-description")).toContainText("محجوب — يحتاج صلاحية نص كشف البنك");
    await expect(page.getByTestId("delivery-withheld-note")).toBeVisible();
    // 🔴 the copy's subtotals are named by the column's own Arabic label — a column the report does not show (the
    // grouping, by account) included; never by its key (found by the 19B walk, 2026-11-27: "… حسب accountId")
    await expect(page.getByTestId("delivery-groups").locator("h2")).toHaveText("المجاميع الفرعية حسب معرّف الحساب");
    await expect(page.getByTestId("delivery-groups")).not.toContainText("accountId");
    await fitsAtPhoneWidth(page, "an opened delivered report");

    // the viewer's own schedule form: everyone else is disabled, and the page says why
    await page.goto("/reports/saved", { waitUntil: "networkidle" });
    const own = page.getByTestId("saved-list").locator("li").filter({ hasText: `Viewer own ${STAMP}` });
    await own.getByRole("button", { name: "جدولة" }).click();
    await expect(page.getByTestId(`schedule-recipient-${userId.viewer}`)).toBeEnabled();
    await expect(page.getByTestId(`schedule-recipient-${userId.bookkeeper}`)).toBeDisabled();
    await expect(page.locator('[data-testid^="schedule-self-only-"]')).toContainText("دورك يسمح بجدولة هذا التقرير لنفسك فقط");
    await fitsAtPhoneWidth(page, "the schedule form");
    await close();
  });
});
