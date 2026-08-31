import { request } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Seed the suite's own tenant, log in once, and save the session.
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
 * no data. So the fixture carries an issued invoice, a partly-paid one, a bill
 * and a payment: enough that a page which cannot render real figures says so.
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

  const orgId = (
    await db.query(
      `INSERT INTO organizations (name, slug, verification_status)
       VALUES ('E2E Smoke Org', $1, 'approved') RETURNING id`,
      [E2E.slug],
    )
  ).rows[0].id as string;

  const companyId = (
    await db.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'E2E Smoke Co') RETURNING id`, [orgId])
  ).rows[0].id as string;

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

  const customerId = (
    await db.query(
      `INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'E2E Customer','310000000000003') RETURNING id`,
      [orgId],
    )
  ).rows[0].id as number;
  const vendorId = (
    await db.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'E2E Vendor') RETURNING id`, [orgId])
  ).rows[0].id as number;

  // Money on both sides, one of each shape a page might get wrong: fully paid,
  // partly paid, unpaid, and a draft that must move nothing.
  await db.query(
    `INSERT INTO invoices
       (organization_id, company_id, customer_id, invoice_number, document_type,
        date, due_date, subtotal, vat_amount, total, paid_amount, status)
     VALUES
       ($1,$2,$3,'E2E-INV-001','invoice','2026-06-01','2026-06-30',1000,150,1150,1150,'paid'),
       ($1,$2,$3,'E2E-INV-002','invoice','2026-07-01','2026-07-31',2000,300,2300,1000,'sent'),
       ($1,$2,$3,'E2E-INV-003','invoice','2026-08-01','2026-08-31',3000,450,3450,0,'sent'),
       ($1,$2,$3,'E2E-INV-004','invoice','2026-08-15','2026-09-15',500,75,575,0,'draft')`,
    [orgId, companyId, customerId],
  );
  await db.query(
    `INSERT INTO bills
       (organization_id, company_id, vendor_id, bill_number, date, due_date,
        subtotal, vat_amount, total, paid_amount, status)
     VALUES
       ($1,$2,$3,'E2E-BILL-001','2026-06-05','2026-07-05',400,60,460,460,'paid'),
       ($1,$2,$3,'E2E-BILL-002','2026-07-10','2026-08-10',800,120,920,0,'received')`,
    [orgId, companyId, vendorId],
  );

  /**
   * ── 🔴 BREADTH — THE THIRD AXIS, ADDED 2026-08-31 AFTER MEASURING IT ──────
   *
   * The fixture above seeds customers, vendors, invoices and bills. That was
   * always known to be "not empty"; what was NOT known, until it was measured,
   * is how little of the product it reaches:
   *
   *   * 11 tenant-scoped tables populated, **40 empty**
   *   * **17 of 54** crawled app routes rendered a row; **37** rendered an
   *     empty state and passed the crawl anyway, because "the body has more
   *     than 20 characters" is satisfied by a heading and "No X found."
   *   * 123 data-driven `.map(` render sites exist across 58 files
   *
   * 🔴 **`invoice_items` and `bill_items` were among the empty forty** — the
   * two most consequential tables in the product. The four seeded invoices had
   * NO LINES, so every render path over a document's lines was unexecuted, on
   * the document type that carries the ZATCA chain.
   *
   * 🔴 **Volume on four entities does not touch thirty-seven routes' render
   * paths.** That is why breadth is a separate axis from the volume and
   * collision work in `tests/scale-and-collision.test.ts`, and not a bigger
   * version of it. Ten thousand invoices still leave `/payroll` empty.
   *
   * ── 🔴 AND THE LIMIT THAT MAKES SEEDING DELIBERATE RATHER THAN OPTIONAL ───
   * **A vacuous pass is indistinguishable from a real pass in every report the
   * suite produces, and no measurement taken from inside the suite can
   * enumerate what was missed.** That is the defect's defining property, not a
   * gap in our tooling: the suite has no way to tell "this assertion held"
   * from "this assertion was never reached". Coverage instrumentation would
   * narrow it and still not close it, because a line can execute against data
   * too uniform to expose a collision.
   *
   * So breadth is SEEDED ON PURPOSE rather than hoped for. `ROWS_EXPECTED` in
   * `routes.ts` is the other half: it names the routes that must render a row,
   * so a page falling back to its empty state goes RED instead of passing
   * quietly. Data without that assertion would just be more rows.
   */
  const bankAccountId = (
    await db.query(
      `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name, currency, balance, opening_balance)
       VALUES ($1,$2,'E2E Current Account','Al Rajhi Bank','SAR',25000,20000) RETURNING id`,
      [orgId, companyId],
    )
  ).rows[0].id as number;

  // Lines for the documents that already existed. Amounts agree with the
  // headers above — a fixture whose lines contradict its totals would make
  // every "the figures are consistent" assertion meaningless.
  await db.query(
    `INSERT INTO invoice_items (organization_id, company_id, invoice_id, description, quantity, unit_price, vat_rate, vat_amount, total)
     SELECT $1, i.company_id, i.id, 'Consulting services', 1, i.subtotal, 15, i.vat_amount, i.total
     FROM invoices i WHERE i.organization_id = $1`,
    [orgId],
  );
  await db.query(
    `INSERT INTO bill_items (organization_id, company_id, bill_id, description, quantity, unit_price, vat_rate, vat_amount, total)
     SELECT $1, b.company_id, b.id, 'Office supplies', 1, b.subtotal, 15, b.vat_amount, b.total
     FROM bills b WHERE b.organization_id = $1`,
    [orgId],
  );

  // A credit note, which the CHECK constraint requires to reference an
  // original invoice AND carry a reason — the schema refuses a floating one.
  await db.query(
    `INSERT INTO invoices
       (organization_id, company_id, customer_id, invoice_number, document_type,
        original_invoice_id, note_reason, date, subtotal, vat_amount, total, status)
     SELECT $1,$2,$3,'E2E-CN-001','credit_note', i.id, 'Goods returned',
            '2026-08-20', 100, 15, 115, 'sent'
     FROM invoices i WHERE i.organization_id = $1 AND i.invoice_number = 'E2E-INV-001'`,
    [orgId, companyId, customerId],
  );

  // A posted journal entry with balanced lines: the ledger reports, the trial
  // balance, and the statements all read from these.
  const jeId = (
    await db.query(
      `INSERT INTO journal_entries
         (organization_id, company_id, entry_number, date, description, status)
       VALUES ($1,$2,'E2E-JE-001','2026-07-15','Opening balance entry','posted') RETURNING id`,
      [orgId, companyId],
    )
  ).rows[0].id as number;
  await db.query(
    `INSERT INTO journal_entry_lines
       (organization_id, company_id, journal_entry_id, account_name, description, debit_amount, credit_amount)
     VALUES
       ($1,$3,$2,'Cash','Opening cash',5000,0),
       ($1,$3,$2,'Owner Equity','Opening equity',0,5000)`,
    [orgId, jeId, companyId],
  );

  // Bank movement. `type` is debit|credit; `kind` defaults to 'operating'.
  await db.query(
    `INSERT INTO transactions
       (organization_id, company_id, bank_account_id, date, description, amount, type, currency)
     VALUES
       ($1,$2,$3,'2026-07-02','Customer payment received',1150,'credit','SAR'),
       ($1,$2,$3,'2026-07-06','Supplier payment',460,'debit','SAR'),
       ($1,$2,$3,'2026-08-03','Office rent',3000,'debit','SAR')`,
    [orgId, companyId, bankAccountId],
  );

  await db.query(
    `INSERT INTO products (organization_id, name, description, unit_price, vat_applicable)
     VALUES ($1,'Consulting hour','Professional services',500,true)`,
    [orgId],
  );

  const employeeId = (
    await db.query(
      `INSERT INTO employees (organization_id, company_id, employee_number, name, basic_salary, status)
       VALUES ($1,$2,'E2E-EMP-001','E2E Employee',8000,'active') RETURNING id`,
      [orgId, companyId],
    )
  ).rows[0].id as number;
  const payrollRunId = (
    await db.query(
      `INSERT INTO payroll_runs (organization_id, company_id, period, status)
       VALUES ($1,$2,'2026-07','approved') RETURNING id`,
      [orgId, companyId],
    )
  ).rows[0].id as number;
  await db.query(
    `INSERT INTO payroll_items
       (organization_id, company_id, payroll_run_id, employee_id, basic_salary, gross_salary, net_pay)
     VALUES ($1,$4,$2,$3,8000,9000,8500)`,
    [orgId, payrollRunId, employeeId, companyId],
  );

  await db.query(
    `INSERT INTO fixed_assets
       (organization_id, company_id, asset_number, name, purchase_date, purchase_cost,
        useful_life_years, current_book_value, status)
     VALUES ($1,$2,'E2E-FA-001','Office laptop','2026-01-15',12000,4,9000,'active')`,
    [orgId, companyId],
  );

  await db.query(
    `INSERT INTO budgets (organization_id, company_id, name, period, budgeted_amount)
     VALUES ($1,$2,'E2E Marketing Budget','2026',50000)`,
    [orgId, companyId],
  );

  const quotationId = (
    await db.query(
      `INSERT INTO quotations
         (organization_id, company_id, customer_id, quotation_number, date, valid_until,
          subtotal, vat_amount, total, status)
       VALUES ($1,$2,$3,'E2E-QUO-001','2026-08-01','2999-01-01',2000,300,2300,'submitted') RETURNING id`,
      [orgId, companyId, customerId],
    )
  ).rows[0].id as number;
  await db.query(
    `INSERT INTO quotation_items
       (organization_id, company_id, quotation_id, description, quantity, unit_price, vat_rate, vat_amount, total)
     VALUES ($1,$3,$2,'Proposed engagement',1,2000,15,300,2300)`,
    [orgId, quotationId, companyId],
  );

  const purchaseOrderId = (
    await db.query(
      `INSERT INTO purchase_orders
         (organization_id, company_id, vendor_id, order_number, date,
          subtotal, vat_amount, total, status)
       VALUES ($1,$2,$3,'E2E-PO-001','2026-08-02',1500,225,1725,'approved') RETURNING id`,
      [orgId, companyId, vendorId],
    )
  ).rows[0].id as number;
  await db.query(
    `INSERT INTO purchase_order_items
       (organization_id, company_id, purchase_order_id, description, quantity, unit_price, vat_rate, vat_amount, total)
     VALUES ($1,$3,$2,'Hardware order',1,1500,15,225,1725)`,
    [orgId, purchaseOrderId, companyId],
  );

  // A recurring rule. Drafts-only by design, so this generates nothing on its
  // own — it exists so `/recurring` renders a row rather than an empty state.
  await db.query(
    `INSERT INTO recurring_rules
       (organization_id, company_id, entity, template, frequency, day_of_month,
        starts_on, next_run_on, status)
     VALUES ($1,$2,'invoice',$3::jsonb,'monthly',1,'2026-01-01','2099-01-01','active')`,
    [orgId, companyId, JSON.stringify({ customerId, items: [{ description: "Retainer", quantity: 1, unitPrice: 1000, vatRate: 15 }] })],
  );

  // A closed month, so `/closed-months` has something to show. Deliberately a
  // period no seeded document falls in, so nothing above becomes unpostable.
  await db.query(
    `INSERT INTO period_locks (organization_id, company_id, period, locked_by)
     VALUES ($1,$2,'2025-12',$3)`,
    [orgId, companyId, userId],
  );

  await db.end();

  /**
   * Wait for the API's READINESS SIGNAL before logging in.
   *
   * 🔴 This is not a retry papering over an ordering problem — the §3 lesson
   * says a retry cannot fix ordering, and it is right. The API has a creator
   * (Playwright's `webServer`) that is scheduled before this, and `/api/health`
   * is its documented readiness signal. Waiting on a signal the server
   * publishes is what `webServer.url` already does; this makes globalSetup
   * independent of the two being ordered, rather than hoping they are.
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
  if (!ready) throw new Error("e2e: the API never became healthy at /api/health");

  const res = await ctx.post("/api/auth/login", { data: { email: E2E.email, password: E2E.password } });
  if (!res.ok()) {
    throw new Error(`e2e login failed: ${res.status()} ${await res.text()}`);
  }
  mkdirSync(dirname(E2E.storageState), { recursive: true });
  await ctx.storageState({ path: E2E.storageState });
  await ctx.dispose();

  writeFileSync(SEEDED_IDS_PATH, JSON.stringify({ customerId, vendorId } satisfies SeededIds, null, 2));
}
