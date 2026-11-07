import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "./fixtures";

/**
 * 🔴 Carry-over Batch 3, F-2 (the owner, 2026-11-07): certificate renewal gets a SCREEN, taking the tenant's own OTP.
 * The route existed with no web caller (the AC-13 standing check). The screen is CLICKED here, in Arabic, at 390 px:
 *  - it appears once a certificate exists, and says renewal is exercised only against ZATCA's sandbox;
 *  - it takes the OTP, confirms naming the unit and the expiry, and sends it once (the field is cleared after);
 *  - it explains, by code, a company whose details ZATCA needs are missing (`zatca_prerequisites_missing`, with each
 *    missing detail named in Arabic) and a role that is not admin (`requires_approval_authority`).
 * 🔴 NOTHING HERE REACHES ZATCA: both refusals happen before any network call, and the certificate row is read back
 * unchanged. A renewal that DOES reach ZATCA runs the onboarding flow against the sandbox, which this suite does not
 * call. Its OWN tenant (an admin and an accountant), created and removed here.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const SLUG = `e2e-renewal-${STAMP}`;
const ADMIN = `e2e-renewal-admin-${STAMP}@smoke.local`;
const ACCOUNTANT = `e2e-renewal-acct-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const EGS = `1-SaudiLedger|2-Platform|3-e2e-${STAMP}`;

let db: Db;
let admin: APIRequestContext;
let accountant: APIRequestContext;
let orgId = "";
let companyId = "";
let credentialId = "";

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const orgs = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const users = `(SELECT id FROM users WHERE email IN ('${ADMIN}','${ACCOUNTANT}'))`;
  // The credential table is per COMPANY, with no organization_id column, so it is removed by its company — and any
  // renewal reminder the scheduler wrote for it first (replica mode does not run the cascade).
  const creds = `(SELECT id FROM zatca_credentials WHERE company_id IN (SELECT id FROM companies WHERE organization_id IN ${orgs}))`;
  await db.query(`DELETE FROM zatca_credential_reminders WHERE credential_id IN ${creds}`);
  await db.query(`DELETE FROM zatca_credentials WHERE company_id IN (SELECT id FROM companies WHERE organization_id IN ${orgs})`);
  const tables = (await db.query(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`,
  )).rows.map((r) => r.table_name as string);
  for (const t of tables) await db.query(`DELETE FROM "${t}" WHERE organization_id IN ${orgs}`);
  await db.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${users} OR target_user_id IN ${users}`);
  await db.query(`DELETE FROM organization_memberships WHERE user_id IN ${users}`);
  await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${users}`);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email IN ($1, $2)`, [ADMIN, ACCOUNTANT]);
  await db.query("COMMIT");
}

async function signIn(email: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  expect((await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok(), `login ${email}`).toBeTruthy();
  expect((await ctx.post("/api/orgs/switch", { data: { organizationId: orgId } })).ok(), `switch ${email}`).toBeTruthy();
  return ctx;
}

const credentials = async () =>
  (await db.query(`SELECT id, status FROM zatca_credentials WHERE company_id = $1 ORDER BY created_at`, [companyId])).rows.map((r) => [r.id as string, r.status as string]);

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PASSWORD, 4);
  orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Renewal Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  // The VAT number and CR are set; the national address and the Arabic name are NOT — the details ZATCA needs.
  companyId = (await db.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Renewal Co','1010606060','300000000000003',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
  for (const [email, role] of [[ADMIN, "admin"], [ACCOUNTANT, "accountant"]] as const) {
    const id = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, `E2E Renewal ${role}`, hash])).rows[0].id;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [orgId, id, role]);
  }
  // An ACTIVE sandbox certificate that expires in 60 days. Its key material is placeholder bytes: nothing in this
  // spec signs, and both refusals below happen before the key is ever read.
  const zero = Buffer.from([0]);
  credentialId = (await db.query(
    `INSERT INTO zatca_credentials (company_id, environment, status, kms_provider, kms_key_id, wrapped_data_key, encrypted_private_key, private_key_iv, private_key_auth_tag, egs_serial_number, not_before, not_after, activated_at)
     VALUES ($1,'sandbox','active','local-dev','e2e-renewal-placeholder',$2,$2,$2,$2,$3, now() - interval '5 years' + interval '60 days', now() + interval '60 days', now()) RETURNING id`,
    [companyId, zero, EGS],
  )).rows[0].id;
  admin = await signIn(ADMIN);
  accountant = await signIn(ACCOUNTANT);
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);
});

test.afterAll(async () => {
  await admin?.dispose();
  await accountant?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

async function openArabic(browser: Browser, who: APIRequestContext): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: await who.storageState(), viewport: PHONE });
  await ctx.addInitScript(() => { try { localStorage.setItem("ksa_lang", "ar"); } catch { /* the default language */ } });
  const page = await ctx.newPage();
  await page.goto("/zatca", { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

/** Type the OTP, continue, read the confirmation, renew; returns the card. */
async function renewWith(page: Page, otp: string) {
  const card = page.getByTestId("renewal-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("renewal-sandbox-only"), "the screen says renewal is exercised only against the sandbox").toContainText("البيئة التجريبية للهيئة فقط");
  await expect(card.getByTestId("renewal-continue"), "nothing to send without an OTP").toBeDisabled();
  await card.getByTestId("renewal-otp").fill(otp);
  await card.getByTestId("renewal-continue").click();
  const line = card.getByTestId("renewal-confirm-line");
  await expect(line, "the confirmation names the unit").toContainText(EGS);
  await expect(line, "and when its certificate expires").toContainText("التي تنتهي في");
  await card.getByTestId("renewal-confirm").click();
  return card;
}

// Not `.serial`: each test reads its own before-state, so one failing does not hide the other (the suite runs a
// file's tests in order, `fullyParallel: false`).
test.describe("certificate renewal (Arabic, 390 px)", () => {
  test("🔴 ADMIN: the renewal is refused by its code while the company's ZATCA details are missing, each named in Arabic; nothing is sent and the certificate is unchanged", async ({ browser }) => {
    test.setTimeout(90_000);
    const before = await credentials();
    expect(before).toEqual([[credentialId, "active"]]);
    const { page, close } = await openArabic(browser, admin);
    const card = await renewWith(page, "123456");
    const refused = card.getByTestId("renewal-refused");
    await expect(refused).toHaveAttribute("data-code", "zatca_prerequisites_missing");
    await expect(refused).toContainText("أكمل بيانات الشركة أولًا");
    await expect(card.getByTestId("renewal-missing"), "each missing detail, in Arabic").toContainText("رقم المبنى");
    await expect(card.getByTestId("renewal-missing")).toContainText("الاسم القانوني بالعربية");
    await expect(refused.getByRole("link", { name: "إعدادات الشركة" })).toBeVisible();
    // the OTP was used once and is not kept in the form
    await card.getByTestId("renewal-again").click();
    await expect(card.getByTestId("renewal-otp")).toHaveValue("");
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w, "no sideways page scroll at 390 px").toBeLessThanOrEqual(PHONE.width + 1);
    expect(await credentials(), "the active certificate is untouched").toEqual(before);
    await close();
  });

  test("🔴 ACCOUNTANT: the renewal is refused by its code — only an admin renews; the certificate is unchanged", async ({ browser }) => {
    test.setTimeout(90_000);
    const before = await credentials();
    const { page, close } = await openArabic(browser, accountant);
    const card = await renewWith(page, "654321");
    const refused = card.getByTestId("renewal-refused");
    await expect(refused).toHaveAttribute("data-code", "requires_approval_authority");
    await expect(refused).toContainText("تجديد الشهادة لمدير النظام فقط");
    expect(await credentials(), "the active certificate is untouched").toEqual(before);
    await close();
  });
});
