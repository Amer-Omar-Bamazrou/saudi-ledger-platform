/**
 * 🔴 B-O6 (Phase 18, contract O-6; owner 2026-10-24 evening, item 3): "every
 * write response whose commit fails becomes an error. No 2xx after a failed
 * commit, without exceptions."
 *
 * A statement error aborts the Postgres transaction. Code that catches it and
 * carries on reaches COMMIT on an aborted transaction, and Postgres answers
 * with the tag ROLLBACK, raising nothing. The tenant seam
 * (`LazyTenantClient.finish`) used to discard that tag, so the request's 2xx
 * went out for a write that did not exist (G60's class).
 *
 * Here the COMMIT's tag is checked. A COMMIT answered ROLLBACK raises
 * `CommitRolledBackError`; the request is answered 500 `commit_rolled_back`
 * and pages `tenant-commit-rolled-back`, a key apart from the database-health
 * page, because the cause is a catch in the code. Names and codes are checked
 * as strings, so this file states the same claims against main.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3230";
process.env.SESSION_SECRET ??= "phase18-b-o6-commit-verification-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import express from "express";
import { sql } from "drizzle-orm";
import { beginTenantConnection, db, pool } from "@workspace/db";
import { resolveTenant } from "../lib/tenant";
import { logger } from "../lib/logger";
import { __setAlerterForTests, type Alerter } from "../lib/alerter";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("B-O6 — a COMMIT answered ROLLBACK is an error, never a success", () => {
  const h = g04Harness("p18bo6");
  let orgId = "";
  let companyId = "";
  let userId = 0;
  const pages: Array<{ key: string; severity: string }> = [];

  const writeMarker = (marker: string) =>
    db.execute(sql`
      INSERT INTO audit_logs (organization_id, action, entity_type, entity_id)
      VALUES (current_setting('app.current_org_id')::uuid, 'create', 'b_o6_marker', ${marker})`);
  const markers = async () =>
    (await pool.query(`SELECT entity_id FROM audit_logs WHERE entity_type = 'b_o6_marker' ORDER BY entity_id`)).rows.map((r) => r.entity_id as string);
  const failInsideTheTransaction = () => db.execute(sql`SELECT 1/0`);
  // drizzle wraps what the client throws, with the original in `cause`.
  const errorName = (p: Promise<unknown>) =>
    p.then(
      () => "resolved — no error",
      (e: unknown) => {
        for (let c = e as { name?: string; cause?: unknown } | undefined; c; c = c.cause as typeof c) {
          if (c.name === "CommitRolledBackError") return c.name;
        }
        return `${(e as Error)?.name}: ${String((e as Error)?.message).slice(0, 160)}`;
      },
    );

  /** A real tenant pipeline (`resolveTenant` + commit-before-response) around one handler. */
  async function serve(handler: express.RequestHandler): Promise<{ status: number; body: unknown }> {
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { session: { userId }, log: logger });
      next();
    });
    app.post("/b-o6", resolveTenant, handler);
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/b-o6`, { method: "POST" });
      return { status: res.status, body: await res.json() };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "B-O6 Co", "318181818181890");
    userId = await h.mkUser("admin", "BO6CommitVerificationPw1!", orgId, "admin");
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE entity_type = 'b_o6_marker'`);
    pages.length = 0;
    const recording: Alerter = {
      fire: async (a) => {
        pages.push({ key: a.key, severity: a.severity });
        return { sent: true };
      },
      resolve: async () => ({ sent: true }),
    };
    __setAlerterForTests(recording);
  });

  afterEach(() => __setAlerterForTests(null));

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE entity_type = 'b_o6_marker'`);
    await h.cleanup();
  });

  it("🔴 the seam: a COMMIT on a transaction a caught error aborted rejects by name, and nothing is written", async () => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    await conn.run(async () => {
      await writeMarker("before-the-caught-error");
      await failInsideTheTransaction().catch(() => undefined); // caught, and carried on
    });
    expect(await errorName(conn.commit())).toBe("CommitRolledBackError");
    expect(await markers()).toEqual([]);
  });

  it("🔴 a request that caught a database error and chose 201 is answered 500 commit_rolled_back, writes nothing, and pages its own key", async () => {
    const res = await serve(async (_req, res) => {
      await writeMarker("request-before-the-caught-error");
      await failInsideTheTransaction().catch(() => undefined);
      res.status(201).json({ saved: true });
    });
    expect(res.status, JSON.stringify(res.body)).toBe(500);
    expect((res.body as { code?: string }).code).toBe("commit_rolled_back");
    expect(await markers(), "nothing written").toEqual([]);
    await expect.poll(() => pages.map((p) => p.key)).toEqual(["tenant-commit-rolled-back"]);
  });

  it("the instrument sees a success: the same request without the error answers 201 and writes, and nobody is paged", async () => {
    const res = await serve(async (_req, res) => {
      await writeMarker("request-healthy");
      res.status(201).json({ saved: true });
    });
    expect(res.status).toBe(201);
    expect(await markers()).toEqual(["request-healthy"]);
    expect(pages).toEqual([]);
  });

  it("an error response is unchanged: it rolls back and is answered as itself, without a page", async () => {
    const res = await serve(async (_req, res) => {
      await writeMarker("request-refused");
      await failInsideTheTransaction().catch(() => undefined);
      res.status(422).json({ code: "refused_by_handler" });
    });
    expect([res.status, (res.body as { code?: string }).code]).toEqual([422, "refused_by_handler"]);
    expect(await markers()).toEqual([]);
    expect(pages).toEqual([]);
  });

  it("a ROLLBACK requested on an aborted transaction is not an error (only COMMIT is checked)", async () => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    await conn.run(() => failInsideTheTransaction().catch(() => undefined));
    expect(await errorName(conn.rollback())).toBe("resolved — no error");
  });
});
