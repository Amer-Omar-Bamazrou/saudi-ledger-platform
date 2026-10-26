/**
 * 🔴 A TENANT TRANSACTION'S HANDLE CANNOT BE USED AFTER ITS TRANSACTION HAS
 * ENDED (Phase 18, owner 2026-10-26, CRITICAL).
 *
 * At the end of a tenant transaction its pooled connection goes back to the
 * pool and may be handed to another transaction straight away. A statement
 * issued afterwards through the old handle must be refused by name
 * (`TenantTransactionEndedError`) before it reaches any connection: it must
 * never run inside another tenant's transaction, nor outside a transaction.
 *
 * Each case checks its precondition rather than assuming it: where the point is
 * "the next transaction on the same connection receives nothing", that next
 * transaction is shown to hold the very connection the first one released.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { beginTenantConnection, db, pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

type Rows<T> = { rows: T[] };

describeMaybe("🔴 a tenant transaction's handle cannot be used after its transaction has ended", () => {
  const h = g04Harness("p18handleend");
  let orgA = "";
  let orgB = "";
  let coA = "";
  let coB = "";

  const backendPid = async () => Number(((await db.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as Rows<{ pid: number }>).rows[0].pid);
  const writeMarker = (marker: string) =>
    db.execute(sql`
      INSERT INTO audit_logs (organization_id, action, entity_type, entity_id)
      VALUES (current_setting('app.current_org_id')::uuid, 'create', 'handle_after_end', ${marker})`);
  const markers = async () =>
    (await pool.query(`SELECT entity_id, organization_id::text AS org FROM audit_logs WHERE entity_type = 'handle_after_end' ORDER BY entity_id`)).rows;
  // drizzle wraps what the client throws ("Failed query: …"), with the original in `cause`.
  const errorName = (p: Promise<unknown>) =>
    p.then(
      () => "resolved — the statement ran",
      (e: unknown) => {
        for (let c = e as { name?: string; cause?: unknown } | undefined; c; c = c.cause as typeof c) {
          if (c.name === "TenantTransactionEndedError") return c.name;
        }
        return `${(e as Error)?.name}: ${String((e as Error)?.message).slice(0, 160)}`;
      },
    );

  beforeEach(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE entity_type = 'handle_after_end'`);
  });

  beforeAll(async () => {
    await h.cleanup();
    await pool.query(`DELETE FROM audit_logs WHERE entity_type = 'handle_after_end'`);
    orgA = await h.mkOrg("a");
    orgB = await h.mkOrg("b");
    coA = await h.mkCompany(orgA, "Handle End A", "318181818181898");
    coB = await h.mkCompany(orgB, "Handle End B", "318181818181899");
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE entity_type = 'handle_after_end'`);
    await h.cleanup();
  });

  it("🔴 after COMMIT: refused by name, and the next transaction on the same connection receives nothing", async () => {
    const connA = await beginTenantConnection({ organizationId: orgA, companyId: coA, role: "authenticated" });
    const pidA = await connA.run(backendPid);
    await connA.commit();

    const connB = await beginTenantConnection({ organizationId: orgB, companyId: coB, role: "authenticated" });
    const pidB = await connB.run(backendPid);
    const outcome = await errorName(connA.run(() => writeMarker("after-commit")));
    await connB.commit();

    expect(pidB, "PRECONDITION: B holds the connection A released").toBe(pidA);
    expect(outcome).toBe("TenantTransactionEndedError");
    expect(await markers(), "nothing written through the ended handle, under any organisation").toEqual([]);
  });

  it("🔴 after ROLLBACK: refused by name", async () => {
    const connA = await beginTenantConnection({ organizationId: orgA, companyId: coA, role: "authenticated" });
    await connA.run(backendPid);
    await connA.rollback();
    expect(await errorName(connA.run(() => writeMarker("after-rollback")))).toBe("TenantTransactionEndedError");
    expect(await markers()).toEqual([]);
  });

  it("🔴 a statement issued in the same moment the transaction ends is refused, never run after the end", async () => {
    const connA = await beginTenantConnection({ organizationId: orgA, companyId: coA, role: "authenticated" });
    await connA.run(backendPid); // the connection is acquired
    // A drizzle query starts only when something calls `.then` on it; calling it
    // here starts the statement NOW, before the end is requested below.
    const pending = connA.run(() => db.execute(sql`SELECT current_user AS who`).then((r) => r));
    const ending = connA.commit(); // same tick: the end is requested before the statement reaches the connection
    const outcome = await errorName(pending);
    await ending;
    expect(outcome).toBe("TenantTransactionEndedError");
  });

  it("🔴 a transaction that ended before it used any connection: refused, and no connection is opened for it", async () => {
    const checkedOut = () => pool.totalCount - pool.idleCount;
    const connA = await beginTenantConnection({ organizationId: orgA, companyId: coA, role: "authenticated" });
    await connA.commit(); // nothing was ever run, so nothing was acquired
    const before = checkedOut();
    const outcome = await errorName(connA.run(() => writeMarker("never-acquired")));
    expect(outcome).toBe("TenantTransactionEndedError");
    expect(checkedOut(), "no connection taken from the pool, so none left behind").toBe(before);
  });

  it("statements awaited before the end are committed (the guard refuses only what comes after)", async () => {
    const connA = await beginTenantConnection({ organizationId: orgA, companyId: coA, role: "authenticated" });
    await connA.run(() => writeMarker("inside-the-transaction"));
    await connA.commit();
    expect(await markers()).toEqual([{ entity_id: "inside-the-transaction", org: orgA }]);
  });
});
