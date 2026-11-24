import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 19B S2c — the bank's own text WITH S2c's removals (v4 §6.1 D2, D4). Arabic, 390 px.
 *
 *  - The VIEWER: the transactions list and the journal entries list mark a bank line's text «محجوب (نص كشف البنك)» —
 *    never a blank — and the text is nowhere in the page; a typed journal entry's own text is still shown.
 *  - The BOOKKEEPER keeps the bank's text (presence).
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-s2c-roles-${STAMP}`;
const USERS = { admin: `e2e-s2cr-adm-${STAMP}@smoke.local`, bookkeeper: `e2e-s2cr-keep-${STAMP}@smoke.local`, viewer: `e2e-s2cr-view-${STAMP}@smoke.local` } as const;
type Role = keyof typeof USERS;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const WITHHELD_BANK_TEXT = "محجوب (نص كشف البنك)";
const BANK_TEXT = `S2C-E2E-BANKTEXT-${String(STAMP).slice(-6)}`;
const TYPED_TEXT = `S2C-E2E-TYPED-${String(STAMP).slice(-6)}`;

let db: Db;
const api = {} as Record<Role, APIRequestContext>;
let txId = 0;

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
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S2c Roles Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S2c Roles Co','1010606060','319898989898983',1,'gregorian')`, [orgId]);
  for (const role of Object.keys(USERS) as Role[]) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [USERS[role], `E2E S2c ${role}`, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
    api[role] = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
    await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
    const login = await api[role].post("/api/auth/login", { data: { email: USERS[role], password: PASSWORD } });
    expect(login.ok(), `login ${role}: ${login.status()}`).toBeTruthy();
    expect((await api[role].post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  const acct = async (code: string) => (await db.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
  const bank = await api.admin.post("/api/bank-accounts", { data: { name: "S2C Ops", bankName: "SNB", currency: "SAR" } });
  expect(bank.status(), await bank.text()).toBe(201);
  const bankId = (await bank.json()).id;
  // the bank's own text: a bank row, posted
  const tx = await api.admin.post("/api/transactions", { data: { date: "2026-10-10", description: BANK_TEXT, amount: 120, currency: "SAR", type: "debit", categoryId: await acct("RENT_UTILITIES"), bankAccountId: bankId } });
  expect(tx.status(), await tx.text()).toBe(201);
  txId = (await tx.json()).id;
  // a typed journal entry: its own words, standard
  const named = async (where: string, p: unknown[]) => (await db.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND ${where}`, [orgId, ...p])).rows[0] as { id: number; name: string };
  const expense = await named("system_code = $2 AND is_posting", ["RENT_UTILITIES"]);
  const cash = await named("bank_account_id = $2", [bankId]);
  const je = await api.admin.post("/api/journal-entries", { data: { date: "2026-10-11", description: TYPED_TEXT, lines: [
    { accountId: expense.id, accountName: expense.name, debitAmount: 50, creditAmount: 0, description: TYPED_TEXT },
    { accountId: cash.id, accountName: cash.name, debitAmount: 0, creditAmount: 50, description: TYPED_TEXT },
  ] } });
  expect(je.status(), await je.text()).toBeLessThan(300);
});

test.afterAll(async () => {
  for (const a of Object.values(api)) await a?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function pageAs(browser: Browser, role: Role, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await api[role].storageState(), viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

test.describe.serial("19B S2c — the bank's own text, with S2c's removals (Arabic, 390 px)", () => {
  test("🔴 viewer: the transactions list marks the bank line's text withheld; the text is nowhere in the page", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "viewer", "/transactions");
    await expect(page.getByTestId(`tx-text-withheld-${txId}`)).toHaveText(WITHHELD_BANK_TEXT);
    expect((await page.content()).includes(BANK_TEXT)).toBe(false);
    await fitsAtPhoneWidth(page, "the transactions list (viewer)");
    await close();
  });

  test("🔴 viewer: the journal entries list marks the bank entry's text withheld and shows the typed entry's own words", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "viewer", "/journal-entries");
    await expect(page.getByText(WITHHELD_BANK_TEXT).first()).toBeVisible();
    await expect(page.getByText(TYPED_TEXT).first()).toBeVisible();
    expect((await page.content()).includes(BANK_TEXT)).toBe(false);
    await close();
  });

  test("presence: the bookkeeper reads the bank's text on both lists", async ({ browser }) => {
    const { page, close } = await pageAs(browser, "bookkeeper", "/transactions");
    await expect(page.getByText(BANK_TEXT).first()).toBeVisible();
    await page.goto("/journal-entries", { waitUntil: "networkidle" });
    await expect(page.getByText(BANK_TEXT).first()).toBeVisible();
    expect((await page.content()).includes(WITHHELD_BANK_TEXT)).toBe(false);
    await close();
  });
});
