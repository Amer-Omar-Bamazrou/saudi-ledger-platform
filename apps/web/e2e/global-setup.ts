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

  const org = `(SELECT id FROM organizations WHERE slug = '${E2E.slug}')`;
  // Idempotent: the suite owns this slug, so it rebuilds it rather than
  // accumulating across runs. Ordered by FK dependency.
  await db.query(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
  await db.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
  await db.query(`DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${org})`);
  await db.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
  await db.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
  await db.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
  await db.query(`DELETE FROM organization_memberships WHERE organization_id IN ${org}`);
  await db.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
  await db.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
  await db.query(`DELETE FROM users WHERE email = $1`, [E2E.email]);
  await db.query(`DELETE FROM organizations WHERE slug = $1`, [E2E.slug]);

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
      ready = (await ctx.get("/api/health")).ok();
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
