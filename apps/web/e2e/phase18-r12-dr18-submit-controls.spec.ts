import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "./fixtures";

/**
 * 🔴 Phase 18 R-12 — DR-18 reading (c), step 2 (register §11.118): every document with a submit route has a Submit
 * control on its own page, so a preparer never depends on the approvals queue to submit.
 *
 * For each of the five — invoice, bill, payroll run, quotation, purchase order — a BOOKKEEPER makes a draft and
 * submits it from the document's own page: the success notice shows, the document reads submitted, and (for the
 * three the approvals queue carries) the queue lists it for the admin. One walk in Arabic on a phone.
 * 🔴 Its OWN tenant, created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-r12-${STAMP}`;
const ALPHA = `e2e-r12-alpha-${STAMP}@smoke.local`;
const KEEPER = `e2e-r12-keeper-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";

let db: Db;
let alphaApi: APIRequestContext;
let keeperApi: APIRequestContext;
let keeperState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let orgId = "";
const ids = { invoice: 0, bill: 0, payroll: 0, quotation: 0, po: 0 };

async function setLang(page: Page, lang: "en" | "ar") {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}

async function json<T>(res: Promise<{ ok: () => boolean; status: () => number; json: () => Promise<any>; text: () => Promise<string> }>, what: string): Promise<T> {
  const r = await res;
  if (!r.ok()) throw new Error(`${what}: ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

const statusOf = async (table: string, id: number) => (await db.query(`SELECT status FROM ${table} WHERE id = $1`, [id])).rows[0]?.status;
const pending = async () => json<Array<{ entity: string; id: number }>>(alphaApi.get("/api/approvals/pending"), "approvals queue");

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email IN ('${ALPHA}','${KEEPER}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2)`, [ALPHA, KEEPER]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E R12 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E R12 Co',1,'gregorian')`, [orgId]);
  for (const [email, name, role] of [[ALPHA, "E2E R12 Alpha", "admin"], [KEEPER, "E2E R12 Keeper", "bookkeeper"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
  }
  alphaApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  keeperApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  for (const [api, email] of [[alphaApi, ALPHA], [keeperApi, KEEPER]] as const) {
    expect((await api.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
    expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  // The BOOKKEEPER prepares five drafts (create is a preparer's act).
  const customer = (await json<{ id: number }>(keeperApi.post("/api/customers", { data: { name: `R12 Customer ${STAMP}` } }), "customer")).id;
  const vendor = (await json<{ id: number }>(keeperApi.post("/api/vendors", { data: { name: `R12 Supplier ${STAMP}` } }), "vendor")).id;
  await json(keeperApi.post("/api/employees", { data: { employeeNumber: `R12-EMP-${STAMP}`, name: "R12 Employee", basicSalary: 6000, status: "active", gosiRegime: "law_1421h" } }), "employee");
  ids.invoice = (await json<{ id: number }>(keeperApi.post("/api/invoices", { data: { invoiceNumber: `R12-INV-${STAMP}`, date: "2026-10-05", dueDate: "2026-10-31", customerId: customer,
    items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] } }), "invoice")).id;
  ids.bill = (await json<{ id: number }>(keeperApi.post("/api/bills", { data: { billNumber: `R12-B-${STAMP}`, date: "2026-10-05", vendorId: vendor,
    items: [{ description: "Supply", quantity: 1, unitPrice: 500, vatRate: 0 }] } }), "bill")).id;
  ids.payroll = (await json<{ id: number }>(keeperApi.post("/api/payroll", { data: { period: "2026-09" } }), "payroll run")).id;
  ids.quotation = (await json<{ id: number }>(keeperApi.post("/api/quotations", { data: { date: "2026-10-05", customerId: customer,
    items: [{ description: "Offer", quantity: 1, unitPrice: 100, vatRate: 15 }] } }), "quotation")).id;
  ids.po = (await json<{ id: number }>(keeperApi.post("/api/purchase-orders", { data: { date: "2026-10-05", vendorId: vendor,
    items: [{ description: "Order", quantity: 1, unitPrice: 100, vatRate: 15 }] } }), "purchase order")).id;
  for (const [table, id] of [["invoices", ids.invoice], ["bills", ids.bill], ["payroll_runs", ids.payroll], ["quotations", ids.quotation], ["purchase_orders", ids.po]] as const) {
    expect(await statusOf(table, id), `${table} starts as a draft`).toBe("draft");
  }
  keeperState = await keeperApi.storageState();
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await alphaApi?.dispose();
  await keeperApi?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function submitFrom(browser: import("@playwright/test").Browser, path: string, testid: string, lang: "en" | "ar" = "en") {
  const ctx = await browser.newContext({ storageState: keeperState, viewport: lang === "ar" ? PHONE : DESKTOP });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await setLang(page, lang);
  const button = page.getByTestId(testid);
  await expect(button).toHaveText(lang === "ar" ? "تقديم للاعتماد" : "Submit");
  await button.click();
  await expect(page.getByText(lang === "ar" ? "قُدّم للاعتماد" : "Submitted for approval").first()).toBeVisible();
  await expect(page.getByTestId(testid), "Submit is offered only on a draft").toHaveCount(0);
  if (lang === "ar") {
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w, "no sideways page scroll on a phone").toBeLessThanOrEqual(PHONE.width + 1);
  }
  await ctx.close();
}

test.describe.serial("R-12 (DR-18 c) — a bookkeeper submits each document from its own page", () => {
  test("🔴 AR phone — an invoice: submitted from the invoices page, and the admin's approvals queue lists it", async ({ browser }) => {
    await submitFrom(browser, "/invoices?status=draft", `submit-invoice-${ids.invoice}`, "ar");
    expect(await statusOf("invoices", ids.invoice)).toBe("submitted");
    expect((await pending()).some((r) => r.entity === "invoices" && r.id === ids.invoice)).toBe(true);
  });

  test("🔴 a bill: submitted from the bills page, and the queue lists it", async ({ browser }) => {
    await submitFrom(browser, "/bills?status=draft", `submit-bill-${ids.bill}`);
    expect(await statusOf("bills", ids.bill)).toBe("submitted");
    expect((await pending()).some((r) => r.entity === "bills" && r.id === ids.bill)).toBe(true);
  });

  test("🔴 a payroll run: submitted from the payroll page, and the queue lists it", async ({ browser }) => {
    await submitFrom(browser, "/payroll", `payroll-submit-${ids.payroll}`);
    expect(await statusOf("payroll_runs", ids.payroll)).toBe("submitted");
    expect((await pending()).some((r) => r.entity === "payroll" && r.id === ids.payroll)).toBe(true);
  });

  test("🔴 a quotation: submitted from the quotations page", async ({ browser }) => {
    await submitFrom(browser, "/quotations", `submit-quotation-${ids.quotation}`);
    expect(await statusOf("quotations", ids.quotation)).toBe("submitted");
  });

  test("🔴 a purchase order: submitted from the purchase orders page", async ({ browser }) => {
    await submitFrom(browser, "/purchase-orders", `submit-purchase-order-${ids.po}`);
    expect(await statusOf("purchase_orders", ids.po)).toBe("submitted");
  });
});
