import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "./fixtures";

/**
 * 🔴 Phase 18 R-6 — DR-23's dual control (register §11.98), walked: in an
 * organisation with TWO admins, changing the account printed on invoices waits
 * for the other admin.
 *
 *  - EN desktop: ALPHA clicks "Use on invoices" on the new account and is told
 *    it waits for a second admin; the printed account does not move; in
 *    Company settings ALPHA sees the request as their own — no Approve, a
 *    Withdraw — with the words for why.
 *  - AR phone: BETA approves it in Company settings; the request reads
 *    approved, the new account is the one printed on invoices, the old one is
 *    not (movement, and the absence beside it).
 *
 * The API suite proves the rule on every path (`phase18-r6-dr23-dual-control.test.ts`);
 * this walks the one bank-detail change the screens offer.
 *
 * 🔴 Its OWN tenant, created and removed here. The first default is set while
 * ALPHA is the only admin (written at once), then BETA joins.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-r6-${STAMP}`;
const ALPHA = `e2e-r6-alpha-${STAMP}@smoke.local`;
const BETA = `e2e-r6-beta-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const BANK_MAIN = `R6 Main ${STAMP}`;
const BANK_NEW = `R6 New ${STAMP}`;
const IBAN_MAIN = "SA0380000000608010167519";
const IBAN_NEW = "SA1310000000111122223333";

let db: Db;
let alphaApi: APIRequestContext;
let betaApi: APIRequestContext;
let alphaState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let betaState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let orgId = "";
let mainId = 0;
let newId = 0;

async function setLang(page: Page, lang: "en" | "ar") {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}

const defaults = async () =>
  (await db.query(`SELECT id, is_default FROM bank_accounts WHERE organization_id = $1 ORDER BY id`, [orgId])).rows.map((r) => [r.id, r.is_default]);
const requests = async () =>
  (await db.query(`SELECT id, kind, bank_account_id, status FROM bank_detail_change_requests WHERE organization_id = $1 ORDER BY id`, [orgId])).rows;

async function json<T>(res: Promise<{ ok: () => boolean; status: () => number; json: () => Promise<any>; text: () => Promise<string> }>, what: string): Promise<T> {
  const r = await res;
  if (!r.ok()) throw new Error(`${what}: ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email IN ('${ALPHA}','${BETA}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2)`, [ALPHA, BETA]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E R6 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E R6 Co',1,'gregorian')`, [orgId]);
  const alphaId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E R6 Alpha',$2,'viewer',true) RETURNING id`, [ALPHA, hash])).rows[0].id;
  const betaId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E R6 Beta',$2,'viewer',true) RETURNING id`, [BETA, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, alphaId]);

  alphaApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  betaApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await alphaApi.post("/api/auth/login", { data: { email: ALPHA, password: PASSWORD } })).ok(), "login alpha").toBeTruthy();
  expect((await alphaApi.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  // ALPHA alone: the first printed account is written at once.
  mainId = (await json<{ id: number }>(alphaApi.post("/api/bank-accounts", { data: { name: BANK_MAIN, bankName: "Al Rajhi", currency: "SAR", iban: IBAN_MAIN, isDefault: true, balance: 0, openingBalance: 0 } }), "main bank")).id;
  // BETA joins: two admins from here on.
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, betaId]);
  expect((await betaApi.post("/api/auth/login", { data: { email: BETA, password: PASSWORD } })).ok(), "login beta").toBeTruthy();
  expect((await betaApi.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  newId = (await json<{ id: number; isDefault: boolean }>(alphaApi.post("/api/bank-accounts", { data: { name: BANK_NEW, bankName: "SNB", currency: "SAR", iban: IBAN_NEW, balance: 0, openingBalance: 0 } }), "new bank")).id;
  alphaState = await alphaApi.storageState();
  betaState = await betaApi.storageState();
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await alphaApi?.dispose();
  await betaApi?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

test.describe.serial("R-6 (DR-23) — the account printed on invoices changes only with a second admin", () => {
  test("🔴 EN desktop: ALPHA's click is held — told it waits, the printed account does not move, and ALPHA cannot approve their own change", async ({ browser }) => {
    expect(await defaults(), "the starting state: Main is printed").toEqual([[mainId, true], [newId, false]]);
    const ctx = await browser.newContext({ storageState: alphaState, viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto("/bank-accounts", { waitUntil: "networkidle" });
    await setLang(page, "en");
    await page.locator("[data-row]", { hasText: BANK_NEW }).getByRole("button", { name: "Use on invoices" }).click();
    await expect(page.getByText("Waiting for a second admin").first()).toBeVisible();
    await expect(page.getByTestId("invoice-bank-account")).toContainText(BANK_MAIN);
    expect(await defaults(), "nothing moved").toEqual([[mainId, true], [newId, false]]);
    const [held] = await requests();
    expect([held?.kind, held?.bank_account_id, held?.status]).toEqual(["default_bank_account", newId, "pending"]);

    await page.goto("/company", { waitUntil: "networkidle" });
    const row = page.getByTestId(`bank-detail-change-${held.id}`);
    await expect(row).toHaveAttribute("data-status", "pending");
    await expect(row).toContainText(BANK_NEW);
    await expect(row).toContainText(`${IBAN_MAIN} → ${IBAN_NEW}`);
    await expect(row.getByText("You asked for this change: another admin approves it.")).toBeVisible();
    await expect(page.getByTestId(`bank-detail-approve-${held.id}`), "no Approve for the person who asked").toHaveCount(0);
    await expect(page.getByTestId(`bank-detail-reject-${held.id}`)).toHaveText("Withdraw");
    await ctx.close();
  });

  test("🔴 AR phone: BETA approves it — the request reads approved, the new account is printed and the old one is not", async ({ browser }) => {
    const [held] = await requests();
    const ctx = await browser.newContext({ storageState: betaState, viewport: PHONE });
    const page = await ctx.newPage();
    await page.goto("/company", { waitUntil: "networkidle" });
    await setLang(page, "ar");
    const row = page.getByTestId(`bank-detail-change-${held.id}`);
    await expect(page.getByTestId(`bank-detail-change-status-${held.id}`)).toHaveText("بانتظار موافقة مسؤول ثانٍ");
    await page.getByTestId(`bank-detail-approve-${held.id}`).click();
    await expect(page.getByText("تمت الموافقة على التغيير وتطبيقه").first()).toBeVisible();
    await expect(row).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId(`bank-detail-change-status-${held.id}`)).toHaveText("تمت الموافقة");
    expect(await defaults(), "the new account is printed, the old one is not").toEqual([[mainId, false], [newId, true]]);
    expect((await requests()).map((r) => r.status)).toEqual(["approved"]);

    await page.goto("/bank-accounts", { waitUntil: "networkidle" });
    await expect(page.getByTestId("invoice-bank-account")).toContainText(BANK_NEW);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w, "no sideways page scroll on a phone").toBeLessThanOrEqual(PHONE.width + 1);
    await ctx.close();
  });
});
