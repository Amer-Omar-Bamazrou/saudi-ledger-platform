import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { businessToday } from "@workspace/shared";

/**
 * 🔴 Carry-over Batch 3, F-1 (the owner, 2026-11-07): the depreciation run and the recognition run get SCREENS.
 * Both routes existed with no web caller (the AC-13 standing check). Each screen is CLICKED here, in Arabic, at 390 px:
 *  - it shows the month and the count (there is no preview endpoint, and the screen says so);
 *  - it confirms naming the month and the count before it posts;
 *  - it lists what posted and what was skipped, each skip explained by its CODE;
 *  - it explains, by code, a closed month (`period_closed`), a role without the grant (`requires_approval_authority`)
 *    and a month with nothing due.
 * Every posting is read back from the API. 🔴 Its OWN tenant (an admin and a viewer), created and removed here: a run
 * posts for EVERY asset and schedule of the company, so it must not run where another spec's figures live.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-runs-${STAMP}`;
const ADMIN = `e2e-runs-admin-${STAMP}@smoke.local`;
const VIEWER = `e2e-runs-viewer-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const shift = (period: string, months: number) => {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const MONTH = businessToday().slice(0, 7);
const PREV = shift(MONTH, -1); // CLOSED by this spec
const FAR = shift(MONTH, 30); // past every schedule here: nothing is due

let db: Db;
let admin: APIRequestContext;
let viewer: APIRequestContext;
let orgId = "";
const asset: Record<"early" | "later", { id: number; number: string }> = { early: { id: 0, number: "" }, later: { id: 0, number: "" } };

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email IN ('${ADMIN}','${VIEWER}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1, $2)`, [ADMIN, VIEWER]);
  await db.query("COMMIT");
}

async function ok<T>(res: Promise<{ ok: () => boolean; status: () => number; json: () => Promise<any>; text: () => Promise<string> }>, what: string) {
  const r = await res;
  if (!r.ok()) throw new Error(`${what}: ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

async function signIn(email: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
  expect((await ctx.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok(), `switch ${email}`).toBeTruthy();
  return ctx;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Runs Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Runs Co','1010505050','300000000000003',1,'gregorian')`, [orgId]);
  for (const [email, role] of [[ADMIN, "admin"], [VIEWER, "viewer"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, `E2E Runs ${role}`, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
  }
  admin = await signIn(ADMIN);
  viewer = await signIn(VIEWER);
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);

  // Two assets put in service by the product's own path — a bill that names the asset, approved:
  // "early" is available from the month this spec closes, "later" from this month.
  const vendorId = (await ok<{ id: number }>(admin.post("/api/vendors", { data: { name: `Runs Supplier ${STAMP}`, taxNumber: "300000000000003" } }), "vendor")).id;
  const categoryId = (await ok<{ id: number }>(admin.post("/api/asset-categories", { data: { name: "Runs equipment", defaultUsefulLifeMonths: 12, incomeTaxGroup: 3, vatCapitalAssetClass: "movable", defaultResidualPct: 0 } }), "category")).id;
  for (const [key, from, cost] of [["early", PREV, 12_000], ["later", MONTH, 6_000]] as const) {
    const a = await ok<{ id: number; assetNumber: string }>(admin.post("/api/assets", { data: { name: `Runs ${key}`, categoryId, acquisitionDate: `${from}-01`, availableForUseDate: `${from}-01`, cost, residualValue: 0, usefulLifeMonths: 12, vatInputTaxAmount: cost * 0.15 } }), `asset ${key}`);
    const bill = await ok<{ id: number }>(admin.post("/api/bills", { data: { supplierDocumentKind: "tax_invoice", vendorReference: `RUNS-SUP-${key}-${STAMP}`, billNumber: `RUNS-BILL-${key}-${STAMP}`, date: `${from}-01`, vendorId, subtotal: cost, vatAmount: cost * 0.15, total: cost * 1.15, capitalisesAssetId: a.id, items: [{ description: "Asset purchase", quantity: 1, unitPrice: cost }] } }), `bill ${key}`);
    await ok(admin.post(`/api/bills/${bill.id}/approve`, { data: {} }), `approve bill ${key}`);
    const read = await ok<{ status: string; assetNumber: string }>(admin.get(`/api/assets/${a.id}`), `read asset ${key}`);
    expect(read.status, `${key} is in service`).toBe("in_service");
    asset[key] = { id: a.id, number: read.assetNumber };
  }
  // Two prepayments: "B3-EARLY" from the month this spec closes, "B3-LATER" from this month.
  const account = async (code: string) => (await db.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
  const expenseAccountId = await account("RENT_UTILITIES");
  const balanceAccountId = await account("PREPAID_EXPENSES");
  for (const [reference, startPeriod] of [["B3-EARLY", PREV], ["B3-LATER", MONTH]] as const) {
    const s = await ok<{ id: number }>(admin.post("/api/recognition-schedules", { data: { kind: "prepayment", reference, description: `Runs ${reference}`, totalAmount: 300, periods: 3, startPeriod, expenseAccountId, balanceAccountId } }), `schedule ${reference}`);
    await ok(admin.post(`/api/recognition-schedules/${s.id}/activate`, { data: {} }), `activate ${reference}`);
  }
  // Close the earlier month, after everything dated in it has posted.
  await ok(admin.post("/api/period-locks", { data: { period: PREV, notes: "e2e: the run screens' closed month" } }), "close the month");
});

test.afterAll(async () => {
  await admin?.dispose();
  await viewer?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function openArabic(browser: Browser, who: APIRequestContext, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await who.storageState(), viewport: PHONE });
  await ctx.addInitScript(() => { try { localStorage.setItem("ksa_lang", "ar"); } catch { /* the default language */ } });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

const noSidewaysScroll = async (page: Page, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll at 390 px`).toBeLessThanOrEqual(PHONE.width + 1);
};

const COUNTED: Record<string, string> = { "depreciation-run": "الأصول في الخدمة", "recognition-run": "الجداول النشطة" };

/** Choose the month, read the count, continue, and read the confirm line; returns the dialog. */
async function choose(page: Page, prefix: string, period: string, count: number) {
  const dlg = page.getByTestId(`${prefix}-dialog`);
  if (!(await dlg.isVisible())) await page.getByTestId(`${prefix}-open`).click();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId(`${prefix}-no-preview`), "the screen says there is no preview").toContainText("لا توجد معاينة");
  await dlg.getByTestId(`${prefix}-period`).fill(period);
  await expect(dlg.getByTestId(`${prefix}-count`), "the count says what it counts").toContainText(COUNTED[prefix]!);
  await expect(dlg.getByTestId(`${prefix}-count-value`), "the count is shown before anything posts").toHaveText(String(count));
  await dlg.getByTestId(`${prefix}-continue`).click();
  const line = dlg.getByTestId(`${prefix}-confirm-line`);
  await expect(line, "the confirmation names the month").toContainText(`شهر ${period}`);
  await expect(line, "and the count, by what it counts").toContainText(`${COUNTED[prefix]}: ${count}.`);
  return dlg;
}

const depreciationOf = async (id: number) => (await ok<{ accumulatedDepreciation: number; postedPeriods: number }>(admin.get(`/api/assets/${id}`), "read asset"));
const recognisedOf = async (reference: string) =>
  (await ok<{ items: Array<{ reference: string; recognisedAmount: number }> }>(admin.get("/api/recognition-schedules"), "schedules")).items.find((s) => s.reference === reference)!.recognisedAmount;

test.describe.serial("the month-end run screens (Arabic, 390 px)", () => {
  test("🔴 DEPRECIATION: a closed month is refused by its code; an open month posts and lists the skipped asset by its code; a month with nothing due says so", async ({ browser }) => {
    test.setTimeout(120_000);
    const { page, close } = await openArabic(browser, admin, "/assets");
    await expect(page.getByTestId("depreciation-run-open")).toHaveText(/تشغيل الإهلاك/);

    // 1. the CLOSED month: the whole run is refused; nothing posts
    let dlg = await choose(page, "depreciation-run", PREV, 2);
    await dlg.getByTestId("depreciation-run-confirm").click();
    const global = page.getByRole("dialog").filter({ hasText: "مُقفل" }).filter({ has: page.getByRole("button", { name: "فهمت" }) });
    await expect(global, "the app's closed-month explanation opens, as for every closed-month refusal").toBeVisible();
    await global.getByRole("button", { name: "فهمت" }).click();
    const refused = dlg.getByTestId("depreciation-run-refused");
    await expect(refused).toHaveAttribute("data-code", "period_closed");
    await expect(refused).toContainText(`شهر ${PREV} مُقفل`);
    expect((await depreciationOf(asset.early.id)).postedPeriods, "nothing posted for the closed month").toBe(0);

    // 2. this month: "later" posts its first month; "early" is skipped, by its code, because its closed month is unposted
    await dlg.getByTestId("depreciation-run-again").click();
    dlg = await choose(page, "depreciation-run", MONTH, 2);
    await dlg.getByTestId("depreciation-run-confirm").click();
    await expect(dlg.getByTestId(`depreciation-run-posted-${asset.later.number}`)).toContainText("500.00");
    await expect(dlg.getByTestId("depreciation-run-total")).toContainText("500.00");
    const skipped = dlg.getByTestId(`depreciation-run-skipped-${asset.early.number}`);
    await expect(skipped).toHaveAttribute("data-code", "depreciation_out_of_order");
    await expect(skipped).toContainText("شهر سابق لم يُهلَك بعد");
    expect((await depreciationOf(asset.later.id)).accumulatedDepreciation, "the posted figure is the server's").toBe(500);
    expect((await depreciationOf(asset.early.id)).postedPeriods).toBe(0);
    await noSidewaysScroll(page, "the depreciation result");

    // 3. a month with nothing due: said, not left blank
    await dlg.getByTestId("depreciation-run-again").click();
    dlg = await choose(page, "depreciation-run", FAR, 2);
    await dlg.getByTestId("depreciation-run-confirm").click();
    await expect(dlg.getByTestId("depreciation-run-nothing-due")).toContainText(`لم يكن شيء مستحقًا في ${FAR}`);
    expect((await depreciationOf(asset.later.id)).accumulatedDepreciation, "nothing more posted").toBe(500);
    await close();
  });

  test("🔴 RECOGNITION: each skip is explained by its code (closed month, no instalment, out of order); the due schedule posts", async ({ browser }) => {
    test.setTimeout(120_000);
    const { page, close } = await openArabic(browser, admin, "/recognition-schedules");
    await expect(page.getByTestId("recognition-run-open")).toHaveText(/تشغيل الشهر/);

    // 1. the CLOSED month: the run answers, and reports each schedule skipped with its code
    let dlg = await choose(page, "recognition-run", PREV, 2);
    await dlg.getByTestId("recognition-run-confirm").click();
    const early = dlg.getByTestId("recognition-run-skipped-B3-EARLY");
    await expect(early).toHaveAttribute("data-code", "period_closed");
    await expect(early).toContainText("الشهر مُقفل");
    const later = dlg.getByTestId("recognition-run-skipped-B3-LATER");
    await expect(later).toHaveAttribute("data-code", "recognition_period_not_scheduled");
    await expect(later).toContainText("لا قسط لهذا الجدول في هذا الشهر");
    await expect(dlg.getByTestId("recognition-run-summary")).toContainText("رُحِّل 0");
    expect(await recognisedOf("B3-EARLY"), "nothing recognised in the closed month").toBe(0);

    // 2. this month: B3-LATER posts 100.00; B3-EARLY is skipped as out of order
    await dlg.getByTestId("recognition-run-again").click();
    dlg = await choose(page, "recognition-run", MONTH, 2);
    await dlg.getByTestId("recognition-run-confirm").click();
    await expect(dlg.getByTestId("recognition-run-posted-B3-LATER")).toContainText("100.00");
    await expect(dlg.getByTestId("recognition-run-skipped-B3-EARLY")).toHaveAttribute("data-code", "recognition_out_of_order");
    expect(await recognisedOf("B3-LATER"), "the posted figure is the server's").toBe(100);
    await noSidewaysScroll(page, "the recognition result");

    // 3. the same month again: already recognised, said by its code
    await dlg.getByTestId("recognition-run-again").click();
    dlg = await choose(page, "recognition-run", MONTH, 2);
    await dlg.getByTestId("recognition-run-confirm").click();
    await expect(dlg.getByTestId("recognition-run-skipped-B3-LATER")).toHaveAttribute("data-code", "recognition_period_already_recognised");
    await expect(dlg.getByTestId("recognition-run-skipped-B3-LATER")).toContainText("سبق الاعتراف به لهذا الشهر");
    expect(await recognisedOf("B3-LATER"), "nothing posted twice").toBe(100);
    await close();
  });

  test("🔴 PERMISSION: a viewer opens both screens and is refused by its code, with the next step; nothing posts", async ({ browser }) => {
    test.setTimeout(120_000);
    const before = (await depreciationOf(asset.early.id)).postedPeriods;
    for (const [path, prefix, words] of [["/assets", "depreciation-run", "دورك لا يسمح بتشغيل الإهلاك"], ["/recognition-schedules", "recognition-run", "دورك لا يسمح بتشغيل الاعتراف"]] as const) {
      const { page, close } = await openArabic(browser, viewer, path);
      const dlg = await choose(page, prefix, MONTH, 2);
      await dlg.getByTestId(`${prefix}-confirm`).click();
      const refused = dlg.getByTestId(`${prefix}-refused`);
      await expect(refused).toHaveAttribute("data-code", "requires_approval_authority");
      await expect(refused).toContainText(words);
      await expect(refused).toContainText("إدارة المستخدمين");
      await noSidewaysScroll(page, `${prefix}, refused`);
      await close();
    }
    expect((await depreciationOf(asset.early.id)).postedPeriods, "the viewer posted nothing").toBe(before);
    expect(await recognisedOf("B3-LATER")).toBe(100);
  });
});
