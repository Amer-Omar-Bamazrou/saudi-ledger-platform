import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";

/**
 * G30 (pre-Phase-18 hardening, 2026-10-07) — an issued invoice keeps the bank
 * details it was issued with, walked through the screens a tenant uses.
 *
 * The API suite proves the rule on the document model and the rendered HTML
 * (`g30-issued-invoice-bank-details.test.ts`); Chromium subsets fonts, so the
 * IBAN is not readable out of the PDF bytes. What only a browser can show:
 *   - the Bank Accounts page states the rule truthfully — the chosen account
 *     governs invoices issued FROM NOW ON, and an issued invoice keeps its own
 *     — in Arabic (RTL, phone) and English (desktop);
 *   - the "Use on invoices" control, clicked, moves the default; the issued
 *     invoice still DOWNLOADS while its stored capture is unchanged; and a new
 *     invoice captures the new default.
 *
 * 🔴 Its OWN tenant, created and removed here: issuing invoices in the shared
 * smoke tenant would move month figures other specs assert on.
 */

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const SLUG = `e2e-g30-${STAMP}`;
const EMAIL = `e2e-g30-${STAMP}@smoke.local`;
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026";
const BANK_A = "G30 Main";
const BANK_B = "G30 Second";
const IBAN_A = "SA0380000000608010167519";
const IBAN_B = "SA4420000001234567891234";

let db: Db;
let api: APIRequestContext;
let state: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let bankA = 0;
let bankB = 0;
let customerId = 0;
let issuedId = 0;
const issuedNumber = `G30-E2E-${STAMP}`;

const json = async (r: Awaited<ReturnType<APIRequestContext["post"]>>, what: string) => {
  expect(r.ok(), `${what}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
};

async function issueInvoice(n: string) {
  const created = await json(
    await api.post("/api/invoices", {
      data: { invoiceNumber: n, date: "2026-10-01", customerId, items: [{ description: "G30 e2e", quantity: 1, unitPrice: 100, vatRate: 15 }] },
    }),
    `create ${n}`,
  );
  await json(await api.post(`/api/invoices/${created.id}/approve`, { data: {} }), `approve ${n}`);
  return created.id as number;
}

async function setLang(page: Page, lang: "en" | "ar") {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}

const capture = async (id: number) =>
  (await db.query(`SELECT issued_bank_account_id AS "bankId", issued_bank_iban AS iban FROM invoices WHERE id = $1`, [id])).rows[0];

async function removeTenant() {
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica");
  const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  for (const t of ["journal_entry_lines", "journal_entries", "invoice_items", "einvoice_documents", "invoices", "customers", "bank_accounts", "audit_logs", "organization_memberships", "categories", "companies"]) {
    await db.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
  }
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  await db.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
  await db.query("COMMIT");
}

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;

  const bcrypt = (await import("bcryptjs")).default;
  const orgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E G30 Org', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
  await db.query(
    `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E G30 Co','شركة جي ٣٠','1010404040','300000000000043',1,'gregorian')`,
    [orgId],
  );
  const uid = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E G30 Admin',$2,'viewer',true) RETURNING id`, [EMAIL, await bcrypt.hash(PASSWORD, 4)])).rows[0].id;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [orgId, uid]);

  api = await pwRequest.newContext({ baseURL: "http://localhost:5173" });
  await json(await api.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD } }), "login");
  state = await api.storageState();
  // The suite's own database: do not let this extra login count toward the
  // per-IP login window the later specs share (global-setup clears it too).
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%'`);

  bankA = (await json(await api.post("/api/bank-accounts", { data: { name: BANK_A, bankName: "Al Rajhi", currency: "SAR", iban: IBAN_A, isDefault: true, balance: 0, openingBalance: 0 } }), "bank A")).id;
  bankB = (await json(await api.post("/api/bank-accounts", { data: { name: BANK_B, bankName: "SNB", currency: "SAR", iban: IBAN_B, balance: 0, openingBalance: 0 } }), "bank B")).id;
  customerId = (await json(await api.post("/api/customers", { data: { name: "G30 Buyer" } }), "customer")).id;
  issuedId = await issueInvoice(issuedNumber);
  expect(await capture(issuedId), "captured at issue").toEqual({ bankId: bankA, iban: IBAN_A });
});

test.afterAll(async () => {
  await api?.dispose();
  if (db) {
    await removeTenant();
    await db.end();
  }
});

test.describe.serial("G30 — the bank on an issued invoice, through the screens", () => {
  test("🔴 AR phone: the page states the rule, the default moves by click, the issued invoice keeps its bank and still downloads", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: state, viewport: PHONE });
    const page = await ctx.newPage();
    await page.goto("/bank-accounts", { waitUntil: "networkidle" });
    await setLang(page, "ar");

    const sentence = page.getByTestId("invoice-bank-account");
    await expect(sentence).toContainText(BANK_A);
    await expect(sentence).toContainText("وتحتفظ الفاتورة الصادرة بالبيانات التي صدرت بها");

    // A real click on the control a tenant uses to change which bank prints.
    const cardB = page.locator("[data-row]", { hasText: BANK_B });
    await cardB.getByRole("button", { name: "استخدمه على الفواتير" }).click();
    await expect(page.getByText("ستظهر بيانات هذا الحساب على الفواتير التي تصدرها من الآن").first()).toBeVisible();
    await expect(sentence).toContainText(BANK_B);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w, "no sideways page scroll on a phone").toBeLessThanOrEqual(PHONE.width + 1);

    // The issued invoice's capture did not move with the click…
    expect(await capture(issuedId)).toEqual({ bankId: bankA, iban: IBAN_A });
    // …and the issued invoice still leaves the product, in Arabic.
    await page.goto("/invoices", { waitUntil: "networkidle" });
    const link = page.locator("tr", { hasText: issuedNumber }).locator('a[href$="lang=ar"]');
    await expect(link).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBe(`${issuedNumber}-ar.pdf`);
    await ctx.close();
  });

  test("EN desktop: the same rule in English, and a NEW invoice captures the new default (movement)", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: state, viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto("/bank-accounts", { waitUntil: "networkidle" });
    await setLang(page, "en");
    const sentence = page.getByTestId("invoice-bank-account");
    await expect(sentence).toContainText(BANK_B);
    await expect(sentence).toContainText("An invoice already issued keeps the details it was issued with.");
    await ctx.close();

    const next = await issueInvoice(`G30-E2E-NEXT-${STAMP}`);
    expect(await capture(next), "the next invoice prints the new default").toEqual({ bankId: bankB, iban: IBAN_B });
    expect(await capture(issuedId), "the first is unmoved, beside it").toEqual({ bankId: bankA, iban: IBAN_A });
  });
});
