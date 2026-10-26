import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * G55 / DR-42 (2026-10-14) — ANOTHER COMPANY'S BANK ACCOUNT, refused where a
 * user meets it, and explained in both languages.
 *
 * The API suites prove the rule (`g55-cross-company-bank-leaf.test.ts`, and the
 * S1 proof `phase18-s1-dr42-cross-company-bank-leaf.test.ts`). What only a
 * browser can show:
 *   - the refusal is REACHABLE from the two forms the defect ran through — the
 *     manual journal and the bookkeeper's prepayment both OFFER the other
 *     company's bank account (the chart is organisation-wide), so the refusal
 *     is what the user actually meets, at save;
 *   - it is EXPLAINED, keyed on the code: in Arabic (RTL, phone) and in English
 *     (desktop, naming the bank account), not a raw sentence in the wrong
 *     language;
 *   - the refused click created NOTHING, and the company's own bank account
 *     still saves the same journal.
 *
 * 🔴 Its OWN tenant, created and removed here (the G30 pattern).
 * 🔴 STAND-IN, named: the product has no way to create a second company or to
 * act as one (signup creates one; every request acts as the organisation's
 * FIRST-created company — apps/api/src/lib/tenant.ts). So company B is created
 * first and B's bank account is created THROUGH THE PRODUCT while B is the only
 * company; then company A is inserted with an EARLIER `created_at`, which makes
 * A the company every later request acts as. Only identity rows (organisation,
 * companies, users, memberships) are written directly.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-g55-${STAMP}`;
const ADMIN = `e2e-g55-admin-${STAMP}@smoke.local`;
const BOOKKEEPER = `e2e-g55-bk-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const BANK_A = "G55 A Main";
const BANK_B = "G55 B Main";

const TITLE = { en: "This company cannot post to that account", ar: "لا يمكن لهذه الشركة الترحيل إلى هذا الحساب" };

let db: Db;
let admin: APIRequestContext;
let bookkeeperState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let orgId = "";
let coA = "";
let coB = "";
let expenseName = "";

const json = async (r: Awaited<ReturnType<APIRequestContext["post"]>>, what: string) => {
  expect(r.ok(), `${what}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
};

async function setLang(page: Page, lang: "en" | "ar") {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}

async function open(browser: Browser, path: string, lang: "en" | "ar", viewport: { width: number; height: number }) {
  const ctx = await browser.newContext({ storageState: bookkeeperState, viewport });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await setLang(page, lang);
  return { ctx, page };
}

/** The tenant's chart, as the pages read it (`/categories` answers a bare array; an envelope is tolerated). */
async function chart(): Promise<Array<{ systemCode: string | null; name: string }>> {
  const body = await json(await admin.get("/api/categories"), "categories");
  return Array.isArray(body) ? body : body.items;
}

/** Journal entries in THIS tenant carrying `description`, read through the product's own list. */
async function journalsDescribed(description: string): Promise<number> {
  const list = await json(await admin.get("/api/journal-entries?limit=100"), "list journals");
  return (list.items as Array<{ description: string }>).filter((e) => e.description === description).length;
}

async function schedulesReferenced(reference: string): Promise<number> {
  const list = await json(await admin.get("/api/recognition-schedules"), "list schedules");
  return (list.items as Array<{ reference: string }>).filter((s) => s.reference === reference).length;
}

/** Fill the journal dialog: Dr expense / Cr `creditAccount` 100, and save. */
async function draftJournal(page: Page, description: string, creditAccount: string) {
  const dialog = page.getByTestId("je-dialog");
  if (!(await dialog.isVisible())) await page.getByTestId("je-new").click();
  await expect(dialog).toBeVisible();
  await page.getByTestId("je-description").fill(description);
  await page.getByTestId("je-line-account-0").click();
  await page.getByRole("option", { name: expenseName, exact: true }).click();
  await page.getByTestId("je-line-debit-0").fill("100");
  await page.getByTestId("je-line-account-1").click();
  await page.getByRole("option", { name: creditAccount, exact: true }).click();
  await page.getByTestId("je-line-credit-1").fill("100");
  await page.getByTestId("je-save").click();
}

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE'
        AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${org}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN (SELECT id FROM users WHERE email = ANY($1::text[]))`, [[ADMIN, BOOKKEEPER]]);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [[ADMIN, BOOKKEEPER]]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;

  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E G55 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  coB = (await db.query(`INSERT INTO companies (organization_id, name, name_ar, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E G55 B Co','شركة ب',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
  for (const [email, role] of [[ADMIN, "admin"], [BOOKKEEPER, "bookkeeper"]] as const) {
    const uid = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, `E2E G55 ${role}`, await bcrypt.hash(PASSWORD, 4)])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, uid, role]);
  }

  admin = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  await json(await admin.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } }), "admin login");
  // B is the only company: this request acts as B, so B's bank is written by the product itself.
  const bankB = (await json(await admin.post("/api/bank-accounts", { data: { name: BANK_B, bankName: "SNB", currency: "SAR", balance: 0, openingBalance: 0 } }), "bank B")).id;
  // A, created "earlier": from here every request acts as A.
  coA = (await db.query(
    `INSERT INTO companies (organization_id, name, name_ar, fiscal_year_start, fiscal_calendar, created_at)
     VALUES ($1,'E2E G55 A Co','شركة أ',1,'gregorian',(SELECT created_at - interval '1 hour' FROM companies WHERE id = $2)) RETURNING id`, [orgId, coB],
  )).rows[0].id;
  const bankA = (await json(await admin.post("/api/bank-accounts", { data: { name: BANK_A, bankName: "Al Rajhi", currency: "SAR", balance: 0, openingBalance: 0 } }), "bank A")).id;
  const owners = (await db.query(`SELECT id, company_id FROM bank_accounts WHERE id = ANY($1::int[]) ORDER BY id`, [[bankB, bankA]])).rows;
  expect(owners.map((r) => r.company_id), "the premise: B's bank is B's, A's is A's").toEqual([coB, coA]);

  const cats = await chart();
  expenseName = cats.find((c) => c.systemCode === "RENT_UTILITIES")!.name;
  expect(cats.map((c) => c.name), "the chart is organisation-wide: A's chart lists B's bank account").toContain(BANK_B);

  const bk = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  await json(await bk.post("/api/auth/login", { data: { email: BOOKKEEPER, password: PASSWORD } }), "bookkeeper login");
  bookkeeperState = await bk.storageState();
  await bk.dispose();
  // The suite's own database: these logins must not count toward the per-IP login window later specs share.
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await admin?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

test.describe.serial("G55 — another company's bank account, refused and explained", () => {
  test("🔴 EN desktop — a manual journal on company B's bank is refused at save, explained naming the bank; nothing is created; A's own bank saves", async ({ browser }) => {
    const { ctx, page } = await open(browser, "/journal-entries", "en", DESKTOP);
    const description = `G55 e2e journal EN ${STAMP}`;

    await draftJournal(page, description, BANK_B);
    const toast = page.getByRole("status").filter({ hasText: TITLE.en });
    await expect(toast, "the refusal is shown, titled for what it is").toBeVisible();
    await expect(toast).toContainText(BANK_B);
    await expect(toast).toContainText("another company");
    await expect(page.getByTestId("je-dialog"), "the form stays open for a correction").toBeVisible();
    expect(await journalsDescribed(description), "the refused save created nothing").toBe(0);

    // The same journal on A's OWN bank: the control that shows the form works.
    await page.getByTestId("je-line-account-1").click();
    await page.getByRole("option", { name: BANK_A, exact: true }).click();
    await page.getByTestId("je-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Journal entry created" })).toBeVisible();
    expect(await journalsDescribed(description)).toBe(1);
    await ctx.close();
  });

  test("🔴 AR phone — the same journal refusal, explained in Arabic (RTL) with the line it names; nothing is created", async ({ browser }) => {
    const { ctx, page } = await open(browser, "/journal-entries", "ar", PHONE);
    const description = `G55 e2e journal AR ${STAMP}`;

    await draftJournal(page, description, BANK_B);
    const toast = page.getByRole("status").filter({ hasText: TITLE.ar });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("السطر 2");
    await expect(toast).toContainText("لبنك تابع لشركة أخرى");
    await expect(toast, "not the server's English sentence").not.toContainText("another company");
    expect(await journalsDescribed(description)).toBe(0);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w, "no sideways page scroll on a phone").toBeLessThanOrEqual(PHONE.width + 1);
    await ctx.close();
  });

  test("🔴 AR phone — a bookkeeper's prepayment on company B's bank is refused at create and explained in Arabic; nothing is created", async ({ browser }) => {
    const { ctx, page } = await open(browser, "/recognition-schedules", "ar", PHONE);
    const reference = `G55-E2E-AR-${STAMP}`;

    await page.getByTestId("new-schedule").click();
    await expect(page.getByTestId("new-schedule-dialog")).toBeVisible();
    await page.getByTestId("schedule-kind").click();
    await page.getByRole("option", { name: "مدفوع مقدمًا — سُدد قبل المنفعة" }).click();
    await page.getByTestId("schedule-reference").fill(reference);
    await page.getByTestId("schedule-description").fill("G55 e2e prepayment");
    await page.getByTestId("schedule-total").fill("300");
    await page.getByTestId("schedule-periods").fill("3");
    await page.getByTestId("schedule-start").fill("2026-10");
    await page.getByTestId("schedule-expense").click();
    await page.getByRole("option").first().click();
    await page.getByTestId("schedule-balance").click();
    await page.getByRole("option", { name: BANK_B, exact: true }).click();
    await page.getByTestId("schedule-submit").click();

    const toast = page.getByRole("status").filter({ hasText: TITLE.ar });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("حساب الميزانية المختار");
    await expect(toast).not.toContainText("another company");
    await expect(page.getByTestId("new-schedule-dialog"), "the form stays open").toBeVisible();
    expect(await schedulesReferenced(reference)).toBe(0);
    await ctx.close();
  });

  test("🔴 EN desktop — the prepayment refusal names the bank in English; the same schedule on Prepaid expenses is created", async ({ browser }) => {
    const { ctx, page } = await open(browser, "/recognition-schedules", "en", DESKTOP);
    const reference = `G55-E2E-EN-${STAMP}`;

    await page.getByTestId("new-schedule").click();
    await page.getByTestId("schedule-kind").click();
    await page.getByRole("option", { name: "Prepayment — paid before the benefit" }).click();
    await page.getByTestId("schedule-reference").fill(reference);
    await page.getByTestId("schedule-description").fill("G55 e2e prepayment");
    await page.getByTestId("schedule-total").fill("300");
    await page.getByTestId("schedule-periods").fill("3");
    await page.getByTestId("schedule-start").fill("2026-10");
    await page.getByTestId("schedule-expense").click();
    await page.getByRole("option").first().click();
    await page.getByTestId("schedule-balance").click();
    await page.getByRole("option", { name: BANK_B, exact: true }).click();
    await page.getByTestId("schedule-submit").click();

    const toast = page.getByRole("status").filter({ hasText: TITLE.en });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(BANK_B);
    await expect(toast).toContainText("another company");
    expect(await schedulesReferenced(reference)).toBe(0);

    // The control: the same schedule on a real prepaid-asset account is created.
    const prepaid = (await chart()).find((c) => c.systemCode === "PREPAID_EXPENSES")!.name;
    await page.getByTestId("schedule-balance").click();
    await page.getByRole("option", { name: prepaid, exact: true }).click();
    await page.getByTestId("schedule-submit").click();
    await expect(page.getByTestId("new-schedule-dialog")).toHaveCount(0);
    expect(await schedulesReferenced(reference)).toBe(1);
    await ctx.close();
  });
});
