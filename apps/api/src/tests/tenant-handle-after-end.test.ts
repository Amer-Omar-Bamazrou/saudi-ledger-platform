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
process.env.PORT ??= "3229";
process.env.SESSION_SECRET ??= "tenant-handle-after-end-test-secret-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import express from "express";
import { sql } from "drizzle-orm";
import { beginTenantConnection, db, pool } from "@workspace/db";
import { resolveTenant } from "../lib/tenant";
import { logger } from "../lib/logger";
import { meteredChat } from "../services/ai/metered";
import type { AiProvider } from "../services/ai/provider";
import { g04Harness } from "./helpers/g04Harness";
import { replica } from "./helpers/replica";

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
    await replica(pool).query(`DELETE FROM audit_logs WHERE entity_type = 'handle_after_end'`);
  });

  beforeAll(async () => {
    await h.cleanup();
    await replica(pool).query(`DELETE FROM audit_logs WHERE entity_type = 'handle_after_end'`);
    orgA = await h.mkOrg("a");
    orgB = await h.mkOrg("b");
    coA = await h.mkCompany(orgA, "Handle End A", "318181818181898");
    coB = await h.mkCompany(orgB, "Handle End B", "318181818181899");
  });

  afterAll(async () => {
    await replica(pool).query(`DELETE FROM audit_logs WHERE entity_type = 'handle_after_end'`);
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

  it("🔴 a request whose transaction ends while its handler is still running: the handler's later statement is refused", async () => {
    const userId = await h.mkUser("abort", "HandleAfterEndPw1!", orgA, "admin");
    const outcomes: string[] = [];
    let atGate!: () => void;
    const reachedGate = new Promise<void>((r) => (atGate = r));
    let sawClose!: () => void;
    const closed = new Promise<void>((r) => (sawClose = r));
    let finished!: () => void;
    const handlerDone = new Promise<void>((r) => (finished = r));

    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { session: { userId }, log: logger });
      next();
    });
    app.get("/handle-after-end", resolveTenant, async (_req, res) => {
      try {
        // Registered after resolveTenant's own `close` listener, so it runs after the rollback began.
        res.on("close", () => sawClose());
        await db.execute(sql`SELECT 1`); // the request's connection is in use
        atGate();
        await closed; // the client has gone; the request's transaction has ended
        outcomes.push(await errorName(db.execute(sql`SELECT current_user AS who`).then((r) => r)));
      } finally {
        finished();
      }
    });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const { port } = server.address() as { port: number };
      const client = new AbortController();
      const request = fetch(`http://127.0.0.1:${port}/handle-after-end`, { signal: client.signal }).catch(() => "aborted");
      await reachedGate;
      client.abort();
      await handlerDone;
      expect(await request).toBe("aborted");
      expect(outcomes).toEqual(["TenantTransactionEndedError"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("the AI meter through an ended transaction loses only its row: the completion is still returned", async () => {
    const provider: AiProvider = {
      name: "handle-after-end-fake",
      chat: async () => ({ text: "completion", model: "m", provider: "handle-after-end-fake", promptTokens: 1, completionTokens: 1, latencyMs: 1 }),
      vision: async () => {
        throw new Error("not used");
      },
    };
    const connA = await beginTenantConnection({ organizationId: orgA, companyId: coA, role: "authenticated" });
    await connA.run(backendPid);
    await connA.commit();
    const out = await connA.run(() => meteredChat(provider, "handle-after-end-meter", { prompt: "x", maxTokens: 5 }));
    expect(out.text).toBe("completion");
    const rows = await pool.query(`SELECT count(*)::int AS n FROM ai_usage WHERE operation = 'handle-after-end-meter'`);
    expect(rows.rows[0].n, "no meter row anywhere").toBe(0);
  });

  it("statements awaited before the end are committed (the guard refuses only what comes after)", async () => {
    const connA = await beginTenantConnection({ organizationId: orgA, companyId: coA, role: "authenticated" });
    await connA.run(() => writeMarker("inside-the-transaction"));
    await connA.commit();
    expect(await markers()).toEqual([{ entity_id: "inside-the-transaction", org: orgA }]);
  });
});
