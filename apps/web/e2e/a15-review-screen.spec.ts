import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * 🔴 A15 review (owner decisions 2026-11-17 and 2026-11-19; migration 0164) — the unclassified-entries review screen,
 * CLICKED: the link from the General Ledger, the screen in Arabic at 390 px (the settled layout, no sideways scroll),
 * an entry the records cannot tie to anything shown as awaiting an accountant-approved policy, a confirmed candidate
 * classified through the confirmation, and a legacy draft's posting refused with the step that comes first.
 * 🔴 Its OWN tenant: the entries are planted as the 0163 back-fill leaves them (only the back-fill writes the tag), and
 * everything is removed afterwards.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-a15rev-${STAMP}`;
const ADMIN = `e2e-a15rev-admin-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const DATE = "2026-10-05";

let db: Db;
let api: APIRequestContext;
let orgId = "";
let mirrored = 0, awaiting = 0, classifiable = 0, draft = 0;
const NUM = { awaiting: `A15REV-AWAIT-${STAMP}`, classifiable: `A15REV-REV-${STAMP}`, draft: `A15REV-DRAFT-${STAMP}` };

async function removeTenant() {
  const users = `(SELECT id FROM users WHERE email = '${ADMIN}')`;
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
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
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E A15 Review Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  const companyId = (await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E A15 Review Co','1010404040','300000000000003',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
  const adminId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E A15 Review Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, adminId]);
  const account = async (code: string) => Number((await db.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id);
  const office = await account("OFFICE_SUPPLIES");
  const income = await account("SALES");
  // Planted as the 0163 back-fill leaves them: an original posted entry, and three legacy entries with their rule-U records.
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const entry = async (num: string, status: string, tag: string, reversalOf: number | null) => {
    const id = (await db.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, posted_at, reversal_of, source_type, approved_by)
       VALUES ($1, $2, $3, $4, 'A15 review walk', $5, CASE WHEN $5 = 'posted' THEN now() END, $6, $7, $8) RETURNING id`,
      [orgId, companyId, num, DATE, status, reversalOf, tag, adminId])).rows[0].id as number;
    await db.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
                    VALUES ($1, $2, $3, $4, 'Office', 75, 0), ($1, $2, $3, $5, 'Income', 0, 75)`, [orgId, companyId, id, office, income]);
    if (tag === "legacy_unclassified") {
      await db.query(`INSERT INTO journal_source_backfill (organization_id, company_id, journal_entry_id, entry_number, entry_status, new_source_type, rule, evidence, migration_version)
                      VALUES ($1, $2, $3, $4, $5, 'legacy_unclassified', 'U', $6::jsonb, '0163_a15_source_tag_mandatory')`,
                      [orgId, companyId, id, num, status, JSON.stringify({ outcome: reversalOf ? "ambiguous" : "no_authoritative_relationship", candidates: [] })]);
    }
    return id;
  };
  mirrored = await entry(`A15REV-ORIG-${STAMP}`, "posted", "manual", null);
  awaiting = await entry(NUM.awaiting, "posted", "legacy_unclassified", null);
  classifiable = await entry(NUM.classifiable, "posted", "legacy_unclassified", mirrored);
  draft = await entry(NUM.draft, "draft", "legacy_unclassified", null);
  await db.query("COMMIT");
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await api.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
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

test.describe("A15 — the unclassified-entries review screen", () => {
  test("🔴 Arabic at 390 px: the General Ledger links to the review, which shows each entry's state and fits the phone", async ({ browser }) => {
    const { page, close } = await open(browser, "ar", "/journal-entries");
    const link = page.getByTestId("je-unclassified-link");
    await expect(link).toContainText("قيود غير مصنَّفة للمراجعة: 3");
    await link.click();
    await expect(page).toHaveURL(/\/journal-entries\/unclassified$/);
    await expect(page.getByRole("heading", { level: 1, name: "القيود غير المصنَّفة" })).toBeVisible();
    await expect(page.getByTestId(`unclassified-${awaiting}`)).toHaveAttribute("data-review-status", "awaiting_policy");
    await expect(page.getByTestId(`unclassified-${awaiting}`).getByTestId("review-status")).toHaveText("بانتظار سياسة يعتمدها المحاسب");
    await expect(page.getByTestId(`unclassified-${classifiable}`)).toHaveAttribute("data-review-status", "classifiable");
    await expect(page.getByTestId(`unclassified-${classifiable}`).getByTestId("classify")).toHaveText("صنِّف بهذا المصدر");
    await expect(page.getByTestId(`unclassified-${draft}`).getByTestId("no-candidates")).toBeVisible();
    // the settled layout at 390 px: nothing scrolls sideways
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal scroll at 390 px").toBeLessThanOrEqual(0);
    await close();
  });

  test("🔴 an admin classifies a confirmed candidate through the confirmation; the entry then reads classified", async ({ browser }) => {
    const { page, close } = await open(browser, "ar", "/journal-entries/unclassified");
    const card = page.getByTestId(`unclassified-${classifiable}`);
    await card.getByTestId("classify").click();
    const dialog = page.getByTestId("classify-confirm");
    await expect(dialog).toContainText("لا يتغيّر فيه إلا مصدره");
    await dialog.getByTestId("classify-confirm-yes").click();
    await expect(card).toHaveAttribute("data-review-status", "classified");
    await expect(card.getByTestId("review-done")).toBeVisible();
    const row = (await db.query(`SELECT source_type, source_id FROM journal_entries WHERE id = $1`, [classifiable])).rows[0];
    expect([row.source_type, row.source_id]).toEqual(["reversal", mirrored]);
    await close();
  });

  test("🔴 posting a legacy draft from the General Ledger is refused with the step that comes first", async ({ browser }) => {
    const { page, close } = await open(browser, "en", "/journal-entries");
    await page.locator("tr", { hasText: NUM.draft }).getByRole("button", { name: "Post" }).click();
    await expect(page.getByText("Classify this entry first", { exact: true })).toBeVisible();
    expect((await db.query(`SELECT status FROM journal_entries WHERE id = $1`, [draft])).rows[0].status, "still a draft").toBe("draft");
    await close();
  });
});
