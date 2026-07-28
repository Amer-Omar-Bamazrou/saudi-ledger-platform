import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { beginTenantConnection, db, customersTable, periodLocksTable } from "../index";

/**
 * MEDIUM-1 — per-request transaction rollback semantics.
 *
 * Since M4 every request runs inside ONE transaction (now lazily acquired, M6).
 * These tests prove that when a query fails partway through a request:
 *   1. the WHOLE request rolls back — earlier writes do NOT persist;
 *   2. the error that surfaces is the ORIGINAL constraint violation, not a
 *      secondary "current transaction is aborted" (25P02) error; and
 *   3. the pooled connection is clean and reusable for the next request.
 *
 * The request transaction is driven through the real `beginTenantConnection`
 * (SET LOCAL ROLE `authenticated` + tenant GUCs), the same path the API uses.
 */

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
if (!connectionString) {
  // eslint-disable-next-line no-console
  console.warn("[tx-rollback] DATABASE_URL not set — skipping rollback tests.");
}

const ROLE = "authenticated";
const PERIOD = "2031-07";

describeMaybe("per-request transaction rollback", () => {
  let owner: pg.Client;
  let orgId = "";
  let companyId = "";

  const runScoped = <T>(fn: () => Promise<T>): Promise<T> => fn();

  beforeAll(async () => {
    owner = new pg.Client({ connectionString });
    await owner.connect();
    await owner.query(`DELETE FROM customers WHERE name = 'TXROLL-A'`);
    await owner.query(`DELETE FROM companies WHERE name = 'TXROLL Co'`);
    await owner.query(`DELETE FROM organizations WHERE slug = 'txroll'`);
    orgId = (await owner.query(`INSERT INTO organizations (name, slug) VALUES ('TXROLL Org','txroll') RETURNING id`)).rows[0].id;
    companyId = (await owner.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'TXROLL Co') RETURNING id`, [orgId])).rows[0].id;
  });

  afterAll(async () => {
    if (!owner) return;
    await owner.query(`DELETE FROM customers WHERE name = 'TXROLL-A'`);
    await owner.query(`DELETE FROM companies WHERE name = 'TXROLL Co'`);
    await owner.query(`DELETE FROM organizations WHERE slug = 'txroll'`);
    await owner.end();
  });

  it("rolls the whole request back on a mid-request DB error, surfacing the real error", async () => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: ROLE });
    let caught: any;
    try {
      await conn.run(() =>
        runScoped(async () => {
          // (A) a successful write earlier in the request — should be undone
          await db.insert(customersTable).values({ name: "TXROLL-A" } as typeof customersTable.$inferInsert);
          // (B) mid-request failure: a duplicate period lock (unique org,company,period)
          await db.insert(periodLocksTable).values({ period: PERIOD } as typeof periodLocksTable.$inferInsert);
          await db.insert(periodLocksTable).values({ period: PERIOD } as typeof periodLocksTable.$inferInsert);
        }),
      );
    } catch (err) {
      caught = err;
    } finally {
      await conn.rollback();
    }

    // The surfaced error is the ORIGINAL unique violation (23505), not 25P02
    // (the pg error is on `.cause`; drizzle wraps it).
    const fullMessage = `${caught?.message ?? ""} ${caught?.cause?.message ?? ""}`.toLowerCase();
    const pgCode = caught?.cause?.code ?? caught?.code;
    expect(caught).toBeTruthy();
    expect(fullMessage).not.toMatch(/current transaction is aborted/);
    expect(pgCode === "23505" || /duplicate key|unique/.test(fullMessage)).toBe(true);

    // Full rollback: the earlier customer write did NOT persist (owner read, bypasses RLS).
    const persisted = await owner.query(`SELECT id FROM customers WHERE name = 'TXROLL-A' AND organization_id = $1`, [orgId]);
    expect(persisted.rowCount).toBe(0);

    // And no period lock persisted either.
    const locks = await owner.query(`SELECT id FROM period_locks WHERE period = $1 AND organization_id = $2`, [PERIOD, orgId]);
    expect(locks.rowCount).toBe(0);
  });

  it("leaves the pooled connection reusable for the next request", async () => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: ROLE });
    // A fresh request-transaction works normally (no lingering aborted state).
    const rows = await conn.run(() =>
      runScoped(() =>
        db
          .select({ id: customersTable.id })
          .from(customersTable)
          .where(and(eq(customersTable.name, "TXROLL-A"))),
      ),
    );
    await conn.commit();
    expect(rows.length).toBe(0); // the rolled-back row is gone
  });
});
