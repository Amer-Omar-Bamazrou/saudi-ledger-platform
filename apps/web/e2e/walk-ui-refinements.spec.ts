import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { E2E } from "./global-setup";

/**
 * 🔴 The 2026-11-16 walk's listed items L3–L5 (the work package's included walk items; owner 2026-11-17 and 2026-11-19),
 * CLICKED, in Arabic at 390 px:
 *  - L3 Users: the role badge and the invitation role picker in the reader's language (they read ADMIN / bookkeeper);
 *    the audit trail's action and record labels in Arabic, and its action column on screen at 390 px.
 *  - L4 Home: the scheduled-findings banner shows the run's BUSINESS date (Asia/Riyadh), one unbroken left-to-right
 *    run — it sliced the UTC date and split it across lines.
 *  - L5 The three cramped layouts: the VAT number fits its field; a credit note's reason is not cut ("…ods returned");
 *    the Treasury chart's labels do not overlap. And a bank-detail change with no IBAN says so (it read "none → none").
 * Read-only on the shared seeded tenant; the banner and the bank-detail change live in a tenant of their own.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-walkui-${STAMP}`;
const ADMIN = `e2e-walkui-admin-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const ARABIC = /[؀-ۿ]/;

let db: Db;
let own: APIRequestContext;
let shared: APIRequestContext;
let orgId = "";
let changeId = 0;
let ranOnRiyadh = "";

async function open(browser: Browser, ctxState: APIRequestContext, path: string, lang: "ar" | "en" = "ar"): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await ctxState.storageState(), viewport: PHONE, locale: lang === "ar" ? "ar-SA" : "en-US" });
  await ctx.addInitScript((l) => { try { localStorage.setItem("ksa_lang", l); } catch { /* storage off */ } }, lang);
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  return { page, close: () => ctx.close() };
}

/** The element's text fits its box: nothing is cut or scrolled inside it. */
const fits = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => (el as HTMLElement).scrollWidth <= (el as HTMLElement).clientWidth + 1);

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
  shared = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Walk UI Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  const companyId = (await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Walk UI Co','1010404040','300000000000003',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
  const adminId = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E Walk UI Admin',$2,'viewer',true) RETURNING id`, [ADMIN, hash])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, adminId]);
  own = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await own.post("/api/auth/login", { data: { email: ADMIN, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await own.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  // L4: a scheduled run eight days ago at 22:30 UTC — already the NEXT day in Riyadh — never opened, so it escalates
  const ran = new Date(Date.now() - 8 * 86_400_000);
  ran.setUTCHours(22, 30, 0, 0);
  ranOnRiyadh = new Date(ran.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
  // 🔴 under the CURRENT period's key (the scheduler's own: findings.schedule.service periodKeyFor, quarterly): the in-process
  // scheduler inserts ON CONFLICT DO NOTHING, so it cannot write a newer run for this organisation mid-test and replace
  // this one as the latest (it did, whenever its tick beat the test — found 2026-11-20)
  const now = new Date();
  const currentPeriod = `${now.getUTCFullYear()}-Q${Math.ceil((now.getUTCMonth() + 1) / 3)}`;
  await db.query(`INSERT INTO finding_runs (organization_id, period_key, trigger, ran_at, open_after) VALUES ($1, $2, 'scheduled', $3, 2)`, [orgId, currentPeriod, ran.toISOString()]);
  // L5: a bank account with no IBAN, and a held change of the account printed on invoices — neither side has an IBAN
  const bank = await own.post("/api/bank-accounts", { data: { name: "Walk UI Bank", bankName: "SNB", currency: "SAR" } });
  expect(bank.ok(), await bank.text()).toBeTruthy();
  const bankId = (await bank.json()).id as number;
  // a request records who asked: the connection declares its actor first, as the product's tenant transaction does
  await db.query("BEGIN");
  await db.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(adminId)]);
  changeId = (await db.query(
    `INSERT INTO bank_detail_change_requests (organization_id, company_id, kind, bank_account_id, iban_before, iban_after, status, requested_by)
     VALUES ($1, $2, 'default_bank_account', $3, NULL, NULL, 'pending', $4) RETURNING id`, [orgId, companyId, bankId, adminId])).rows[0].id;
  await db.query("COMMIT");
  // L3: the WORST rows a phone can be shown, planted as the newest — a record id that is a 36-character UUID (it cannot
  // wrap at a space) under the longest Arabic record label. Main's run of 2026-11-20 put such a row first in the shared
  // tenant and the table overflowed; #350's own run happened to show short ids first. Breadth is seeded, never hoped for.
  await db.query("BEGIN");
  // in the SHARED tenant (the audit test reads it; this spec's own tenant keeps its unopened findings run for L4)
  const me = await (await shared.get("/api/auth/me")).json();
  const sharedOrg = (await db.query(`SELECT organization_id FROM organization_memberships WHERE user_id = $1 AND status = 'active' ORDER BY id LIMIT 1`, [me.id])).rows[0].organization_id;
  await db.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(me.id)]);
  for (const entity of ["vat_return_filing", "zatca_credential"]) {
    await db.query(`INSERT INTO audit_logs (organization_id, action, entity_type, entity_id) VALUES ($1, 'update', $2, gen_random_uuid()::text)`, [sharedOrg, entity]);
  }
  await db.query("COMMIT");
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await own?.dispose();
  await shared?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

test.describe("The walk's listed items, in Arabic at 390 px", () => {
  test("🔴 L3 Users: the role badge and the invitation role picker read in Arabic", async ({ browser }) => {
    const { page, close } = await open(browser, shared, "/users");
    const badges = page.locator('[data-testid^="role-badge-"]');
    await expect(badges.first()).toBeVisible();
    for (const text of await badges.allTextContents()) expect(text.trim(), "a role in Arabic").toMatch(ARABIC);
    await expect(badges.filter({ hasText: "مسؤول" }).first(), "the admin reads مسؤول").toBeVisible();
    await expect(page.getByText("ADMIN", { exact: true }), "no raw role").toHaveCount(0);
    const options = await page.locator("select option").allTextContents();
    expect(options.filter((o) => /^(viewer|bookkeeper|accountant|admin)$/.test(o.trim())), "no raw role in a picker").toEqual([]);
    await close();
  });

  test("🔴 L3 Audit trail: actions and records in Arabic, and the action column on screen", async ({ browser }) => {
    const { page, close } = await open(browser, shared, "/audit-trail");
    // the planted worst row (the page may also show newer rows, e.g. an on-demand findings run: the table must fit them all)
    const first = page.locator("tbody tr", { hasText: "شهادة هيئة الزكاة والضريبة والجمارك" }).first();
    await expect(first).toBeVisible();
    const action = first.locator("td").nth(3);
    await expect(action).toHaveText(ARABIC);
    // the action itself has no English word left (the record's id beside it may be a code, e.g. #on-demand)
    await expect(action.getByTestId("audit-action")).not.toHaveText(/[a-z]{3,}/);
    // the record is named in Arabic — on a phone, under its action
    await expect(action.getByTestId("audit-record-compact")).toHaveText(ARABIC);
    // 🔴 font-independent (main run 44713001354: CI fonts clipped the header by 1.5 px, Windows fonts fitted): a record id
    // that is a UUID must be able to break, so the table can never be wider than the phone — and the rule is on the ID
    // ONLY (owner, 2026-11-20): `break-all` on the whole line also broke the Arabic label mid-word (at 11 px «والضريبة»
    // split into «و» / «الضريبة»). `overflow-wrap: anywhere` breaks the id only where it would overflow, and still
    // lowers the table's minimum width.
    const compact = action.getByTestId("audit-record-compact");
    expect(await compact.locator('span[dir="ltr"]').evaluate((el) => getComputedStyle(el).overflowWrap), "the record id breaks only where it would overflow").toBe("anywhere");
    expect(await compact.evaluate((el) => getComputedStyle(el).wordBreak), "the Arabic label never breaks mid-word").toBe("normal");
    await expect(page.getByRole("columnheader", { name: "الإجراء" })).toBeInViewport({ ratio: 1 });
    await expect(action, "the whole action cell on screen").toBeInViewport({ ratio: 1 });
    // nothing in the table scrolls sideways, and both filters are on screen
    const table = page.locator("table").first();
    expect(await table.evaluate((el) => (el.parentElement as HTMLElement).scrollWidth <= (el.parentElement as HTMLElement).clientWidth + 1), "the table fits").toBe(true);
    for (const trigger of await page.getByRole("combobox").all()) await expect(trigger).toBeInViewport({ ratio: 1 });
    await close();
  });

  test("🔴 L4 Home: the scheduled-findings banner shows the run's Riyadh business date, on one line", async ({ browser }) => {
    const { page, close } = await open(browser, own, "/");
    const date = page.getByTestId("findings-banner-date");
    await expect(date).toHaveText(ranOnRiyadh);
    await expect(date).toHaveAttribute("dir", "ltr");
    const box = await date.boundingBox();
    expect(box && box.height, "one line").toBeLessThan(26);
    await close();
  });

  test("🔴 L5 the VAT number fits its field at 390 px", async ({ browser }) => {
    const { page, close } = await open(browser, shared, "/company");
    const vat = page.locator("#vatNumber");
    await expect(vat).toBeVisible();
    await vat.fill("300000000000003");
    expect(await fits(page, "#vatNumber"), "all fifteen digits show").toBe(true);
    await close();
  });

  test("🔴 L5 a credit note's reason is not cut", async ({ browser }) => {
    const { page, close } = await open(browser, shared, "/credit-notes");
    const reason = page.getByTestId("credit-note-reason").filter({ hasText: "Goods returned" }).first();
    await expect(reason).toBeVisible();
    expect(await reason.evaluate((el) => (el as HTMLElement).scrollWidth <= (el as HTMLElement).clientWidth + 1), "the whole reason shows").toBe(true);
    await close();
  });

  test("🔴 L5 the Treasury chart's labels do not overlap — no text in the chart lies over another", async ({ browser }) => {
    const { page, close } = await open(browser, shared, "/treasury");
    const chart = page.getByTestId("treasury-chart").first();
    const texts = chart.locator("svg text");
    await expect(texts.first()).toBeVisible();
    // every text the chart draws — axis numbers and any label — as a box; two boxes that share area overlap
    const boxes = await texts.evaluateAll((els) => els
      .map((e) => { const r = e.getBoundingClientRect(); return { s: e.textContent ?? "", l: r.left, r: r.right, t: r.top, b: r.bottom }; })
      .filter((x) => x.s.trim() !== "" && x.r > x.l));
    expect(boxes.length, "the chart draws its axis numbers").toBeGreaterThan(3);
    const clashes: string[] = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], c = boxes[j];
      if (Math.min(a.r, c.r) - Math.max(a.l, c.l) > 0.5 && Math.min(a.b, c.b) - Math.max(a.t, c.t) > 0.5) clashes.push(`"${a.s}" over "${c.s}"`);
    }
    expect(clashes, "no text in the chart lies over another").toEqual([]);
    // the dashed line is still named — below the chart, in the reader's language
    await expect(page.getByTestId("treasury-chart-reference").first()).toHaveText(ARABIC);
    await close();
  });

  test("🔴 L5 a bank-detail change with no IBAN says so, never \"none → none\"", async ({ browser }) => {
    const { page, close } = await open(browser, own, "/company", "en");
    const change = page.getByTestId(`bank-detail-change-${changeId}`);
    await expect(change).toContainText("No IBAN on either side of the change");
    await expect(change).not.toContainText("none → none");
    await close();
  });
});
