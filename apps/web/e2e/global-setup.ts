import { request } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHONE_BOOKS, SMOKE_BOOKS, api, seedBooks, type SeededBooks } from "./seedBooks";

/**
 * Seed the suite's own tenant THROUGH THE PRODUCT, log in once, save the session.
 *
 * 🔴 THE DATA IS THIS SUITE'S OWN, AND IT IS NOT THE DEV ORG. A crawl that
 * asserts against whatever happens to be in a developer's database asserts
 * against a moving target, and the first person to delete a customer makes it
 * red for a reason that is not a regression.
 *
 * 🔴 IT IS ALSO NOT EMPTY, and that matters more than it sounds. A smoke crawl
 * over empty lists is the weakest possible version of itself: every page
 * renders its empty state, nothing touches a money path, and the pages that
 * broke in this project's history — a GL showing SAR 0.00, an AP aging page
 * that rendered blank, a KPI that was a permanent zero — all render *fine* with
 * no data.
 *
 * ── 🔴 AND IT IS WRITTEN BY THE PRODUCT'S OWN WRITE PATH (2026-09-15) ────────
 * The first version of this file INSERTed business rows directly. Measured on
 * the second core-path walk: every issued document and every ledger row it
 * wrote was one the product could not produce — invoices in `sent`/`paid` with
 * no hash, QR, ICV, issue date or GL entry; bills in posted states with no GL;
 * an approved payroll with no GL; journal lines with no account (the server
 * refuses them); an asset whose cost ≠ book + accumulated. The statements met
 * impossible rows (the balance sheet excluded the account-less lines and read
 * ALL ZERO against 4,635.00 of open invoices), and 12 of the crawl's 29
 * rows-expected routes were satisfied by exactly those rows. Nothing noticed,
 * because "a row renders" was the only assertion — see
 * `statement-figures.spec.ts` for the one that would have failed.
 *
 * So now: the IDENTITY layer (organization, company, user, membership — outside
 * RLS by design, and the sign-up path would park the org in `pending_review`)
 * is still inserted directly. EVERYTHING ELSE is created by logging in and
 * calling the API the pages call: invoices with lines, submitted and approved
 * (hash, QR, ICV, GL — the real chain), paid through the pay path; a credit
 * note against a paid invoice; bills posted and paid; a payroll run approved
 * (GL); an opening entry with real account ids, posted; a draft asset under a
 * category (FA-A); bank transactions imported through the upload path so they
 * land in review. Standing rule 2 applied to the browser suite: only real rows
 * test the code you forgot to write.
 *
 * The document numbers are kept (`invoiceNumber`/`billNumber` are accepted on
 * create) so every locator in the specs still resolves.
 */

/**
 * Batch 1C (2026-09-20): the migration workspace spec needs a tenant whose
 * ledger is EMPTY on and before the opening date (control LEDGER_EMPTY), a
 * property the smoke tenant deliberately lacks. So: a SECOND tenant, seeded
 * with identity rows + one bank account only, with an admin (runs the
 * migration) and an accountant (may only read it), each with its own saved
 * session. Everything the spec stages is staged through the UI.
 */
export const E2E_MIGRATION = {
  slug: "e2e-migration",
  adminEmail: "e2e-migration-admin@smoke.local",
  accountantEmail: "e2e-migration-acct@smoke.local",
  password: process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026",
  adminState: join(dirname(fileURLToPath(import.meta.url)), ".auth", "migration-admin.json"),
  accountantState: join(dirname(fileURLToPath(import.meta.url)), ".auth", "migration-accountant.json"),
};

/**
 * Phase 13B S1 (2026-09-30): an opening payable's VAT history is declared on a
 * COMMITTED migration, and the migration tenant above is committed by its own
 * spec through the UI — so a THIRD tenant, committed by the S1 spec through the
 * API, with the three roles the declaration's permission separates: an admin
 * and an accountant (may declare) and a bookkeeper (may not).
 */
export const E2E_S1 = {
  slug: "e2e-s1-opening-vat",
  adminEmail: "e2e-s1-admin@smoke.local",
  accountantEmail: "e2e-s1-acct@smoke.local",
  bookkeeperEmail: "e2e-s1-bk@smoke.local",
  password: process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026",
  adminState: join(dirname(fileURLToPath(import.meta.url)), ".auth", "s1-admin.json"),
  accountantState: join(dirname(fileURLToPath(import.meta.url)), ".auth", "s1-accountant.json"),
  bookkeeperState: join(dirname(fileURLToPath(import.meta.url)), ".auth", "s1-bookkeeper.json"),
};

/**
 * The accountant's answers Q1–Q3 (2026-10-05; pack phase-16-17 §14): a FOURTH tenant, owned by the two specs that
 * walk them. Q3 reverses a migration (the migration tenant above ends blocked and S1 stays committed); Q1/Q2 make
 * WHT payments — which, in the shared smoke tenant, changed the month's return lines another spec asserts on
 * (CI 37311565856: phase16-tax's consulting line read 900.00, not its own 500.00). Nothing else reads this tenant.
 */
export const E2E_ANSWERS = {
  slug: "e2e-accountant-answers",
  adminEmail: "e2e-answers-admin@smoke.local",
  password: process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026",
  adminState: join(dirname(fileURLToPath(import.meta.url)), ".auth", "answers-admin.json"),
};

/**
 * The phone-fit tenant (2026-11-21): the books the smoke tenant has, written with the WORST values a page plausibly
 * meets (seedBooks.ts, PHONE_BOOKS), and read by ONE spec only — the route crawl's 390 px pass. Nothing else writes to
 * it, so what that pass measures cannot depend on what other specs left behind (#360 went red on rows the local frame
 * never had).
 */
export const E2E_PHONE = {
  slug: "e2e-phone-fit",
  email: "e2e-phone-fit@smoke.local",
  password: process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026",
  state: join(dirname(fileURLToPath(import.meta.url)), ".auth", "phone-fit.json"),
  ids: join(dirname(fileURLToPath(import.meta.url)), ".auth", "phone-fit-ids.json"),
};

export const E2E = {
  slug: "e2e-smoke",
  email: "e2e@smoke.local",
  /**
   * A fixture credential for a throwaway tenant, not a secret. It exists in
   * plain sight because CI must be able to reproduce the run exactly; override
   * it with E2E_PASSWORD where that matters.
   */
  password: process.env.E2E_PASSWORD ?? "e2e-smoke-password-2026",
  storageState: join(dirname(fileURLToPath(import.meta.url)), ".auth", "state.json"),
};

// The one origin: the API serves the web build and `/api` on the same port (playwright.config.ts).
const API = "http://localhost:5173";

/** ids the crawl needs for parameterised routes; written out by the seed. */
export interface SeededIds {
  customerId: number;
  vendorId: number;
  /** Phase F: the one bank account, and the receipt held on account (a deposit). */
  bankId: number;
  depositPaymentId: number;
  /** Batch 1C: a DRAFT migration batch in the smoke tenant (no ledger effect), so `/migration/:id` is crawlable. */
  migrationBatchId: number;
  /** Batch 1C: the migration tenant's bank account (the spec maps the old bank row to it). */
  migrationBankId: number;
  /** Phase 15: the smoke tenant's APPROVED 2026 base budget, so `/budgets/:id` is crawlable. */
  budgetId: number;
  /** Phase 16: the smoke tenant's DRAFT FY 2025 Zakat computation, so `/tax/computations/:id` is crawlable. */
  taxComputationId: number;
}

export const SEEDED_IDS_PATH = join(dirname(fileURLToPath(import.meta.url)), ".auth", "ids.json");

export default async function globalSetup(): Promise<void> {
  const { Client } = await import("pg");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for the e2e suite");

  const db = new Client({ connectionString });
  await db.connect();

  /**
   * 🔴 THE WIPE IS DERIVED, NOT ENUMERATED.
   *
   * The first version listed the child tables by hand and broke the moment the
   * scheduled-findings job wrote a `finding_runs` row for the seeded org:
   *   `update or delete on "organizations" violates foreign key constraint
   *    "finding_runs_organization_id_organizations_id_fk"`.
   *
   * A hand-kept list of org-scoped tables is a second representation of the
   * schema, and it rots silently every time a table is added — the same shape
   * as the hand-kept route list this suite already refuses to have. So the set
   * is read from `information_schema` at run time: every table carrying an
   * `organization_id` column is cleared.
   *
   * FK triggers are disabled for the wipe (`session_replication_role`), which
   * removes the need to know the dependency ORDER as well as the table set.
   * Child rows that hang off a document rather than the org (invoice_items,
   * bill_items) are cleared first, since they carry no `organization_id` and
   * would otherwise be orphaned.
   */
  const { rows: orgRows } = await db.query<{ id: string }>(
    `SELECT id FROM organizations WHERE slug = ANY($1::text[])`,
    [[E2E.slug, E2E_MIGRATION.slug, E2E_S1.slug, E2E_ANSWERS.slug, E2E_PHONE.slug]],
  );

  if (orgRows.length > 0) {
    const ids = orgRows.map((r) => r.id);
    // BASE TABLES only: `journal_line_bank_identity` (D-3, migration 0073) is
    // a VIEW carrying organization_id, and a DELETE against it fails.
    const { rows: scoped } = await db.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE'`,
    );

    await db.query(`SET session_replication_role = replica`);
    try {
      await db.query(
        `DELETE FROM invoice_items WHERE invoice_id IN
           (SELECT id FROM invoices WHERE organization_id = ANY($1::uuid[]))`,
        [ids],
      );
      await db.query(
        `DELETE FROM bill_items WHERE bill_id IN
           (SELECT id FROM bills WHERE organization_id = ANY($1::uuid[]))`,
        [ids],
      );
      for (const { table_name } of scoped) {
        // Identifier interpolation is safe here: the names come from
        // information_schema, not from input, and are quoted.
        await db.query(`DELETE FROM "${table_name}" WHERE organization_id = ANY($1::uuid[])`, [ids]);
      }
      await db.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [[E2E.email, E2E_MIGRATION.adminEmail, E2E_MIGRATION.accountantEmail, E2E_S1.adminEmail, E2E_S1.accountantEmail, E2E_S1.bookkeeperEmail, E2E_ANSWERS.adminEmail, E2E_PHONE.email]]);
      await db.query(`DELETE FROM organizations WHERE slug = ANY($1::text[])`, [[E2E.slug, E2E_MIGRATION.slug, E2E_S1.slug, E2E_ANSWERS.slug, E2E_PHONE.slug]]);
    } finally {
      await db.query(`SET session_replication_role = DEFAULT`);
    }
  } else {
    await db.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [[E2E.email, E2E_MIGRATION.adminEmail, E2E_MIGRATION.accountantEmail, E2E_S1.adminEmail, E2E_S1.accountantEmail, E2E_S1.bookkeeperEmail, E2E_ANSWERS.adminEmail, E2E_PHONE.email]]);
  }

  // ── The identity layer: the only rows written directly ─────────────────────
  const orgId = (
    await db.query(
      `INSERT INTO organizations (name, slug, verification_status)
       VALUES ('E2E Smoke Org', $1, 'approved') RETURNING id`,
      [E2E.slug],
    )
  ).rows[0].id as string;

  await db.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'E2E Smoke Co')`, [orgId]);

  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(E2E.password, 10);
  const userId = (
    await db.query(
      `INSERT INTO users (email, name, password_hash, role, is_active)
       VALUES ($1,'E2E Smoke','${hash}','admin', true) RETURNING id`,
      [E2E.email],
    )
  ).rows[0].id as number;

  await db.query(
    // `status` (default 'active'), not `is_active` — checked against
    // information_schema rather than assumed from the users table's shape.
    `INSERT INTO organization_memberships (organization_id, user_id, role, status)
     VALUES ($1,$2,'admin','active')`,
    [orgId, userId],
  );

  // ── The migration tenant (Batch 1C): identity only; the spec stages the rest through the UI ──
  const migOrgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Migration Org', $1, 'approved') RETURNING id`, [E2E_MIGRATION.slug])).rows[0].id as string;
  await db.query(`INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Migration Co','شركة الترحيل','1010202020','300000000000023',1,'gregorian')`, [migOrgId]);
  for (const [email, role, name] of [[E2E_MIGRATION.adminEmail, "admin", "E2E Migration Admin"], [E2E_MIGRATION.accountantEmail, "accountant", "E2E Migration Accountant"]] as const) {
    const uid = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,'${hash}','viewer', true) RETURNING id`, [email, name])).rows[0].id as number;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [migOrgId, uid, role]);
  }
  // ── The S1 tenant (Phase 13B S1): identity only; the spec commits its migration through the API ──
  const s1OrgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E S1 Opening VAT Org', $1, 'approved') RETURNING id`, [E2E_S1.slug])).rows[0].id as string;
  await db.query(`INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E S1 Co','شركة الضريبة الافتتاحية','1010303030','300000000000033',1,'gregorian')`, [s1OrgId]);
  for (const [email, role, name] of [[E2E_S1.adminEmail, "admin", "E2E S1 Admin"], [E2E_S1.accountantEmail, "accountant", "E2E S1 Accountant"], [E2E_S1.bookkeeperEmail, "bookkeeper", "E2E S1 Bookkeeper"]] as const) {
    const uid = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,'${hash}','viewer', true) RETURNING id`, [email, name])).rows[0].id as number;
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [s1OrgId, uid, role]);
  }
  // ── The accountant-answers tenant: identity only; its specs make WHT payments and commit/reverse/replace a migration ──
  const q3OrgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Accountant Answers Org', $1, 'approved') RETURNING id`, [E2E_ANSWERS.slug])).rows[0].id as string;
  await db.query(`INSERT INTO companies (organization_id, name, name_ar, fiscal_year_start, fiscal_calendar) VALUES ($1,'E2E Answers Co','شركة إجابات المحاسب',1,'gregorian')`, [q3OrgId]);
  const q3Uid = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'E2E Answers Admin','${hash}','viewer', true) RETURNING id`, [E2E_ANSWERS.adminEmail])).rows[0].id as number;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [q3OrgId, q3Uid]);
  // ── The phone-fit tenant: identity only; its books are seeded below, through the product, with the worst values ──
  const phoneOrgId = (await db.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('E2E Phone Fit Org', $1, 'approved') RETURNING id`, [E2E_PHONE.slug])).rows[0].id as string;
  await db.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'E2E Phone Fit Co')`, [phoneOrgId]);
  const phoneUid = (await db.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'عبدالرحمن بن عبدالعزيز بن محمد الحربي','${hash}','viewer', true) RETURNING id`, [E2E_PHONE.email])).rows[0].id as number;
  await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`, [phoneOrgId, phoneUid]);
  // The suite now logs three users in per run (Batch 1C added a second tenant);
  // the login limiter is 10 per 15 minutes per IP, so a few local re-runs would
  // start answering 429 for reasons that are not regressions. This is the
  // suite's own database: clear the auth counters it filled — and the request
  // budget's (`budget:%`, 2026-10-05), whose ten-minute upload and export
  // windows a quick local re-run would otherwise inherit.
  await db.query(`DELETE FROM rate_limit_hits WHERE key LIKE 'auth%' OR key LIKE 'budget:%'`);
  await db.end();

  /**
   * Wait for the API's READINESS SIGNAL before logging in.
   *
   * 🔴 This is not a retry papering over an ordering problem — the §3 lesson
   * says a retry cannot fix ordering, and it is right. The API has a creator
   * (Playwright's `webServer`, whose plugin setup the runner schedules before
   * this file) and `/api/healthz` is its documented readiness signal. Waiting
   * on a signal the server publishes is what `webServer.url` already does;
   * this makes globalSetup independent of the two being ordered, rather than
   * hoping they are.
   */
  const ctx = await request.newContext({ baseURL: API, extraHTTPHeaders: { origin: API } });
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    try {
      ready = (await ctx.get("/api/healthz")).ok();
    } catch {
      /* not up yet */
    }
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error("e2e: the API never became healthy at /api/healthz");

  const login = await ctx.post("/api/auth/login", { data: { email: E2E.email, password: E2E.password } });
  if (!login.ok()) throw new Error(`e2e login failed: ${login.status()} ${await login.text()}`);

  // ── Everything below is the product writing its own rows (the sequence lives in seedBooks.ts) ──
  const smoke: SeededBooks = await seedBooks(ctx, SMOKE_BOOKS);

  mkdirSync(dirname(E2E.storageState), { recursive: true });
  await ctx.storageState({ path: E2E.storageState });
  await ctx.dispose();

  // The migration tenant: log both users in, give it one bank account (the old bank row maps to it).
  const migAdmin = await request.newContext({ baseURL: API, extraHTTPHeaders: { origin: API } });
  const migLogin = await migAdmin.post("/api/auth/login", { data: { email: E2E_MIGRATION.adminEmail, password: E2E_MIGRATION.password } });
  if (!migLogin.ok()) throw new Error(`e2e migration admin login failed: ${migLogin.status()}`);
  const migBank = await api(migAdmin, "POST", "/bank-accounts", { name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" });
  // FA-D: a migrated asset names an EXISTING asset category (its accounts, its Art. 17 group and its Art. 52 class).
  await api(migAdmin, "POST", "/asset-categories", { name: "Migrated equipment", nameAr: "معدات مرحَّلة", defaultUsefulLifeMonths: 50, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" });
  await migAdmin.storageState({ path: E2E_MIGRATION.adminState });
  await migAdmin.dispose();
  const migAcct = await request.newContext({ baseURL: API, extraHTTPHeaders: { origin: API } });
  const acctLogin = await migAcct.post("/api/auth/login", { data: { email: E2E_MIGRATION.accountantEmail, password: E2E_MIGRATION.password } });
  if (!acctLogin.ok()) throw new Error(`e2e migration accountant login failed: ${acctLogin.status()}`);
  await migAcct.storageState({ path: E2E_MIGRATION.accountantState });
  await migAcct.dispose();

  // The S1 tenant: three sessions, and one bank account (the old bank row maps to it).
  for (const [email, state, withBank] of [[E2E_S1.adminEmail, E2E_S1.adminState, true], [E2E_S1.accountantEmail, E2E_S1.accountantState, false], [E2E_S1.bookkeeperEmail, E2E_S1.bookkeeperState, false]] as const) {
    const s1 = await request.newContext({ baseURL: API, extraHTTPHeaders: { origin: API } });
    const login = await s1.post("/api/auth/login", { data: { email, password: E2E_S1.password } });
    if (!login.ok()) throw new Error(`e2e S1 login failed for ${email}: ${login.status()}`);
    if (withBank) await api(s1, "POST", "/bank-accounts", { name: "S1 Main", bankName: "Riyad Bank", currency: "SAR" });
    await s1.storageState({ path: state });
    await s1.dispose();
  }

  // The accountant-answers tenant: one session, one bank account and the asset category Q3's migrated asset names.
  const q3 = await request.newContext({ baseURL: API, extraHTTPHeaders: { origin: API } });
  const q3Login = await q3.post("/api/auth/login", { data: { email: E2E_ANSWERS.adminEmail, password: E2E_ANSWERS.password } });
  if (!q3Login.ok()) throw new Error(`e2e accountant-answers login failed: ${q3Login.status()}`);
  await api(q3, "POST", "/bank-accounts", { name: "Answers Main", bankName: "Riyad Bank", currency: "SAR" });
  await api(q3, "POST", "/asset-categories", { name: "Q3 machinery", nameAr: "آلات", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" });
  await q3.storageState({ path: E2E_ANSWERS.adminState });
  await q3.dispose();

  // The phone-fit tenant: one session, and the books with the worst values (seedBooks.ts, PHONE_BOOKS).
  const phone = await request.newContext({ baseURL: API, extraHTTPHeaders: { origin: API } });
  const phoneLogin = await phone.post("/api/auth/login", { data: { email: E2E_PHONE.email, password: E2E_PHONE.password } });
  if (!phoneLogin.ok()) throw new Error(`e2e phone-fit login failed: ${phoneLogin.status()}`);
  const phoneBooks = await seedBooks(phone, PHONE_BOOKS);
  await phone.storageState({ path: E2E_PHONE.state });
  await phone.dispose();
  writeFileSync(E2E_PHONE.ids, JSON.stringify(phoneBooks, null, 2));

  writeFileSync(SEEDED_IDS_PATH, JSON.stringify({ customerId: smoke.customerId, vendorId: smoke.vendorId, bankId: smoke.bankId, depositPaymentId: smoke.depositPaymentId, migrationBatchId: smoke.migrationBatchId, migrationBankId: migBank.id, budgetId: smoke.budgetId, taxComputationId: smoke.taxComputationId } satisfies SeededIds, null, 2));
}
