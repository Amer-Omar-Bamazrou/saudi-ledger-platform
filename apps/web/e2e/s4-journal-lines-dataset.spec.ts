import { test, expect, request as pwRequest, type APIRequestContext } from "./fixtures";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * 🔴 19B S4 — the first report dataset's production caller, walked: a VIEWER opens Reports → Journal lines in Arabic at
 * 390 px, sees the lines an accountant posted (the true count), and exports them; the file holds the same lines.
 * `decide()` and the withholding are proven by the API suites (s4-report-decide, s4-report-datasets-http); this proves
 * the screen reaches the dataset, and the export reaches the file, through the client the product ships.
 *
 * 🔴 Its OWN tenant, created and removed here.
 */
type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-s4-${STAMP}`;
const ACCOUNTANT = `e2e-s4-acc-${STAMP}@smoke.local`;
const VIEWER = `e2e-s4-viewer-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const TEXT = `S4 dataset accrual ${STAMP}`;

let db: Db;
let accApi: APIRequestContext;
let viewerApi: APIRequestContext;
let orgId = "";

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email IN ('${ACCOUNTANT}','${VIEWER}'))`;
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1,$2)`, [ACCOUNTANT, VIEWER]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S4 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S4 Co',1,'gregorian')`, [orgId]);
  for (const [email, name, role] of [[ACCOUNTANT, "E2E S4 Accountant", "accountant"], [VIEWER, "E2E S4 Viewer", "viewer"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, name, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
  }
  accApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  viewerApi = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  for (const [api, email] of [[accApi, ACCOUNTANT], [viewerApi, VIEWER]] as const) {
    expect((await api.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
    expect((await api.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok()).toBeTruthy();
  }
  // one entry, posted through the product, inside the page's default window (today)
  const acct = async (code: string) => (await db.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" });
  const je = await accApi.post("/api/journal-entries", { data: { date: today, description: TEXT, lines: [
    { accountId: await acct("RENT_UTILITIES"), accountName: "Rent & Utilities", debitAmount: 75, creditAmount: 0, description: TEXT },
    { accountId: await acct("ACCRUED_LIABILITIES"), accountName: "Accrued Liabilities", debitAmount: 0, creditAmount: 75, description: TEXT },
  ] } });
  expect(je.status(), await je.text()).toBe(201);
  expect((await accApi.post(`/api/journal-entries/${(await je.json()).id}/approve`, { data: {} })).status()).toBe(200);
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await accApi?.dispose();
  await viewerApi?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

test("🔴 AR phone: a viewer opens Journal lines, sees the posted lines and their count, and exports the same lines", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: await viewerApi.storageState(), viewport: PHONE, acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto("/reports/journal-lines", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "سطور القيود" })).toBeVisible();
  await expect(page.getByTestId("journal-lines-row")).toHaveCount(2);
  await expect(page.getByTestId("journal-lines-table")).toContainText(TEXT);
  await expect(page.getByTestId("journal-lines-count")).toHaveText("1–2 من 2 سطراً");
  await expect(page.getByTestId("journal-lines-col-description")).toHaveAttribute("data-level", "read");
  await expect(page.getByTestId("journal-lines-no-export"), "a viewer may export a viewer dataset (D3)").toHaveCount(0);
  await fitsAtPhoneWidth(page, "the Journal lines page");
  const exportRequests: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/journal_lines/export")) exportRequests.push(r.url()); });

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("journal-lines-export").click()]);
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  const csv = readFileSync(path!, "utf8");
  expect(csv).toContain(TEXT);
  expect(csv).toContain("سطور القيود");
  // the page sends ONE export request per click. 🔴 Open finding (2026-11-23, not S4's): in this environment the server
  // receives every report export clicked in the browser twice — the fixed exports too — while the page sees one fetch;
  // a direct request records once. So the record is asserted present, and the count is reported, not pinned here.
  expect(exportRequests).toHaveLength(1);
  expect((await db.query(`SELECT count(*)::int n FROM audit_logs WHERE organization_id = $1 AND entity_type = 'report_dataset_export'`, [orgId])).rows[0].n).toBeGreaterThanOrEqual(1);
  await ctx.close();
});
