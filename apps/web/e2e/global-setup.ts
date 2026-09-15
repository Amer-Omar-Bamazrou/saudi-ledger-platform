import { request, type APIRequestContext } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * (GL); an opening entry with real account ids, posted; an asset depreciated
 * by the product; bank transactions imported through the upload path so they
 * land in review. Standing rule 2 applied to the browser suite: only real rows
 * test the code you forgot to write.
 *
 * The document numbers are kept (`invoiceNumber`/`billNumber` are accepted on
 * create) so every locator in the specs still resolves.
 */

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

const API = "http://localhost:3000";

/** ids the crawl needs for parameterised routes; written out by the seed. */
export interface SeededIds {
  customerId: number;
  vendorId: number;
}

export const SEEDED_IDS_PATH = join(dirname(fileURLToPath(import.meta.url)), ".auth", "ids.json");

/** One API call; any non-2xx is a seed failure that names the call and the server's answer. */
async function api<T = any>(ctx: APIRequestContext, method: "GET" | "POST" | "PATCH", path: string, data?: unknown): Promise<T> {
  const res = await ctx.fetch(`/api${path}`, { method, data, headers: { "content-type": "application/json" } });
  if (!res.ok()) throw new Error(`e2e seed: ${method} ${path} → ${res.status()} ${(await res.text()).slice(0, 400)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

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
    `SELECT id FROM organizations WHERE slug = $1`,
    [E2E.slug],
  );

  if (orgRows.length > 0) {
    const ids = orgRows.map((r) => r.id);
    const { rows: scoped } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'organization_id'`,
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
      await db.query(`DELETE FROM users WHERE email = $1`, [E2E.email]);
      await db.query(`DELETE FROM organizations WHERE slug = $1`, [E2E.slug]);
    } finally {
      await db.query(`SET session_replication_role = DEFAULT`);
    }
  } else {
    await db.query(`DELETE FROM users WHERE email = $1`, [E2E.email]);
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
  const ctx = await request.newContext({ baseURL: API });
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

  // ── Everything below is the product writing its own rows ───────────────────

  // Issuing an invoice fails closed without the company's VAT number (the
  // walk of 2026-09-15 hit exactly this 400). Set the legal identity first.
  await api(ctx, "PATCH", "/companies/current", {
    name: "E2E Smoke Co",
    nameAr: "شركة الاختبار",
    crNumber: "1010101010",
    vatNumber: "300000000000003",
    fiscalCalendar: "gregorian",
  });

  const customer = await api(ctx, "POST", "/customers", { name: "E2E Customer", taxNumber: "310000000000003" });
  const vendor = await api(ctx, "POST", "/vendors", { name: "E2E Vendor" });
  const customerId = customer.id as number;
  const vendorId = vendor.id as number;

  // The chart: the seeded system accounts plus one equity account for the
  // opening entry (the seeded chart's only equity account is the transfers
  // one, which is not where owner capital goes).
  const categories: Array<{ id: number; name: string; systemCode: string | null; type: string }> = await api(ctx, "GET", "/categories");
  const cash = categories.find((c) => c.systemCode === "CASH");
  if (!cash) throw new Error("e2e seed: the seeded chart has no CASH account");
  const equity = await api(ctx, "POST", "/categories", {
    name: "Owner Equity",
    nameAr: "حقوق الملكية",
    type: "equity",
    vatApplicable: false,
  });

  // Opening entry — real account ids, posted through the JE path.
  const je = await api(ctx, "POST", "/journal-entries", {
    entryNumber: "E2E-JE-001",
    date: "2026-07-15",
    description: "Opening balance entry",
    lines: [
      { accountId: cash.id, accountName: cash.name, debitAmount: 5000, creditAmount: 0 },
      { accountId: equity.id, accountName: equity.name, debitAmount: 0, creditAmount: 5000 },
    ],
  });
  await api(ctx, "POST", `/journal-entries/${je.id}/post`);

  // Money on both sides, one of each shape a page might get wrong: fully paid,
  // partly paid, unpaid, and a draft that must move nothing. Approved in date
  // order so the ICV chain is the one a tenant would have.
  const line = (description: string, unitPrice: number) => [{ description, quantity: 1, unitPrice, vatRate: 15 }];
  const invoice = async (invoiceNumber: string, date: string, dueDate: string, subtotal: number) =>
    api(ctx, "POST", "/invoices", { invoiceNumber, date, dueDate, customerId, items: line("Consulting services", subtotal) });
  const issue = async (id: number) => {
    await api(ctx, "POST", `/invoices/${id}/submit`);
    await api(ctx, "POST", `/invoices/${id}/approve`);
  };

  const inv1 = await invoice("E2E-INV-001", "2026-06-01", "2026-06-30", 1000);
  await issue(inv1.id);
  await api(ctx, "POST", `/invoices/${inv1.id}/pay`, { amount: 1150, paidAt: "2026-06-28" });

  const inv2 = await invoice("E2E-INV-002", "2026-07-01", "2026-07-31", 2000);
  await issue(inv2.id);
  await api(ctx, "POST", `/invoices/${inv2.id}/pay`, { amount: 1000, paidAt: "2026-07-20" });

  const inv3 = await invoice("E2E-INV-003", "2026-08-01", "2026-08-31", 3000);
  await issue(inv3.id);

  await invoice("E2E-INV-004", "2026-08-15", "2026-09-15", 500); // stays a draft

  // A credit note against the PAID invoice — the shape aging must show as a
  // negative receivable (item 7 of the 2026-09-15 walk).
  const cn = await api(ctx, "POST", "/invoices", {
    invoiceNumber: "E2E-CN-001",
    documentType: "credit_note",
    originalInvoiceId: inv1.id,
    noteReason: "Goods returned",
    date: "2026-08-20",
    customerId,
    items: line("Goods returned", 100),
  });
  await issue(cn.id);

  // Bills: posted through the bill path (PURCHASES by default), one paid.
  const bill = async (billNumber: string, date: string, dueDate: string, subtotal: number) =>
    api(ctx, "POST", "/bills", {
      billNumber,
      date,
      dueDate,
      vendorId,
      subtotal,
      vatAmount: subtotal * 0.15,
      total: subtotal * 1.15,
      items: line("Office supplies", subtotal),
    });
  const bill1 = await bill("E2E-BILL-001", "2026-06-05", "2026-07-05", 400);
  await api(ctx, "POST", `/bills/${bill1.id}/post`, {});
  await api(ctx, "POST", `/bills/${bill1.id}/pay`, { amount: 460, paidAt: "2026-07-06" });
  const bill2 = await bill("E2E-BILL-002", "2026-07-10", "2026-08-10", 800);
  await api(ctx, "POST", `/bills/${bill2.id}/post`, {});

  // A bank account and three imported movements — the upload path is what
  // lands rows in review, which is the state the review page exists for.
  const bank = await api(ctx, "POST", "/bank-accounts", {
    name: "E2E Current Account",
    bankName: "Al Rajhi Bank",
    currency: "SAR",
    balance: 25000,
    openingBalance: 20000,
  });
  await api(ctx, "POST", "/transactions/upload", {
    bankAccountId: bank.id,
    rows: [
      { date: "2026-07-02", description: "Customer payment received", amount: 1150, type: "credit", currency: "SAR" },
      { date: "2026-07-06", description: "Supplier payment", amount: 460, type: "debit", currency: "SAR" },
      { date: "2026-08-03", description: "Office rent", amount: 3000, type: "debit", currency: "SAR" },
    ],
  });

  await api(ctx, "POST", "/products", {
    name: "Consulting hour",
    type: "service",
    unit: "unit",
    description: "Professional services",
    unitPrice: 500,
    vatApplicable: true,
    stockQty: 0,
  });

  await api(ctx, "POST", "/employees", { employeeNumber: "E2E-EMP-001", name: "E2E Employee", basicSalary: 8000, status: "active" });

  // A payroll run: created from the employees, approved through the workflow
  // (which posts the GL — the old seed's "approved" run had none).
  const run = await api(ctx, "POST", "/payroll", { period: "2026-07" });
  await api(ctx, "POST", `/payroll/${run.id}/submit`);
  await api(ctx, "POST", `/payroll/${run.id}/approve`);

  // An asset, depreciated by the product for six months so cost = book +
  // accumulated holds by construction and the history explains the balance.
  const asset = await api(ctx, "POST", "/assets", {
    assetNumber: "E2E-FA-001",
    name: "Office laptop",
    purchaseDate: "2026-01-15",
    purchaseCost: 12000,
    salvageValue: 0,
    usefulLifeYears: 4,
  });
  for (const period of ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]) {
    await api(ctx, "POST", `/assets/${asset.id}/depreciate`, { period });
  }

  await api(ctx, "POST", "/budgets", { name: "E2E Marketing Budget", period: "2026", budgetedAmount: 50000 });

  const quotation = await api(ctx, "POST", "/quotations", {
    date: "2026-08-01",
    validUntil: "2026-12-31",
    customerId,
    items: line("Proposed engagement", 2000),
  });
  await api(ctx, "POST", `/quotations/${quotation.id}/submit`);

  const po = await api(ctx, "POST", "/purchase-orders", { date: "2026-08-02", vendorId, items: line("Hardware order", 1500) });
  await api(ctx, "POST", `/purchase-orders/${po.id}/submit`);
  await api(ctx, "POST", `/purchase-orders/${po.id}/approve`);

  // A recurring rule. Drafts-only by design, and dated so the scheduler never
  // generates from it — it exists so `/recurring` renders a row.
  await api(ctx, "POST", "/recurring", {
    entity: "invoice",
    template: { customerId, items: line("Retainer", 1000) },
    frequency: "monthly",
    dayOfMonth: 1,
    startsOn: "2099-01-01",
  });

  // A closed month, so `/closed-months` has something to show. Deliberately a
  // period no seeded document falls in, so nothing above becomes unpostable.
  await api(ctx, "POST", "/period-locks", { period: "2025-12" });

  mkdirSync(dirname(E2E.storageState), { recursive: true });
  await ctx.storageState({ path: E2E.storageState });
  await ctx.dispose();

  writeFileSync(SEEDED_IDS_PATH, JSON.stringify({ customerId, vendorId } satisfies SeededIds, null, 2));
}
