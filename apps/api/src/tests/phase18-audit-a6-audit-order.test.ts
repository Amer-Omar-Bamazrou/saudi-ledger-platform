/**
 * 🔴 Phase 18 audit (2026-11-09), finding A6 — G25's "sequence or chain": the audit trail's TIME and ORDER are the
 * database's, never the writer's.
 *
 * `audit_logs.created_at` was a column DEFAULT, so any writer holding INSERT could name its own time — a row written
 * today could claim to be from 2020, or from 2030, and read as history in that place. There was no sequence, so the
 * order of rows in one transaction (one `now()`) was undefined. G25's contract control is "actor taken from the
 * session only; sequence or chain". The actor half is 0132's (control T1b; its re-set gap waits on DR-09's login role); this is
 * the time-and-order half.
 *
 * Presence, absence, movement: a row's time is the transaction's whatever the writer claimed; rows are numbered in the
 * order written, and a writer's own number is ignored; the Audit Trail lists the later-written row first. The owner's
 * replica mode stays the one way to plant history (test fixtures), as 0132 documents. DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3396";
process.env.SESSION_SECRET ??= "phase18-audit-a6-audit-order-0000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { replica } from "./helpers/replica";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA6AuditOrderPw1!";
const KIND = "a6probe";

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }>; release: () => void };
type Row = Record<string, unknown> & { seq?: unknown; created_at: string; at_db_now: boolean };

describeMaybe("Phase 18 audit A6 — the audit trail's time and order are the database's", () => {
  const h = g04Harness("auda6");
  let orgId = "", companyId = "", adminId = 0;

  /** As the request's own role, in this tenant, acting as the admin — COMMITTED, as the product writes. */
  const asApp = async <T>(fn: (c: Client) => Promise<T>): Promise<{ value?: T; error?: string }> => {
    const c = (await pool.connect()) as unknown as Client;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
      await c.query("SELECT set_config('app.current_user_id', $1, true)", [String(adminId)]);
      const value = await fn(c);
      await c.query("COMMIT");
      return { value };
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      return { error: (err as Error).message };
    } finally {
      c.release();
    }
  };
  const write = (c: Client, entityId: string, createdAt: string | null = null) =>
    c.query(
      createdAt === null
        ? `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id) VALUES ($1, 'create', '${KIND}', $2)
           RETURNING to_jsonb(audit_logs.*) || jsonb_build_object('at_db_now', audit_logs.created_at = now()::timestamp) AS r`
        : `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, created_at) VALUES ($1, 'create', '${KIND}', $2, $3::timestamp)
           RETURNING to_jsonb(audit_logs.*) || jsonb_build_object('at_db_now', audit_logs.created_at = now()::timestamp) AS r`,
      createdAt === null ? [orgId, entityId] : [orgId, entityId, createdAt],
    ).then((x) => x.rows[0]!.r as Row);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit A6 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 the database sets the time: a row written claiming 2020 carries its transaction's time", async () => {
    const r = await asApp((c) => write(c, "A6-TIME", "2020-01-01 09:00:00"));
    expect(r.error).toBeUndefined();
    const row = r.value!;
    expect(String(row.created_at).slice(0, 4), "the writer's claimed year").not.toBe("2020");
    expect(row.at_db_now, "the row's time is its transaction's now()").toBe(true);
  });

  it("🔴 the database sets the order: rows written in one transaction are numbered in the order written", async () => {
    const r = await asApp(async (c) => [await write(c, "A6-SEQ-1"), await write(c, "A6-SEQ-2"), await write(c, "A6-SEQ-3")]);
    expect(r.error).toBeUndefined();
    const seqs = r.value!.map((x) => x.seq);
    expect(seqs.every((s) => typeof s === "number"), `each row carries a database sequence: ${JSON.stringify(seqs)}`).toBe(true);
    const n = seqs as number[];
    expect(n[1]! > n[0]! && n[2]! > n[1]!, `strictly increasing in the order written: ${n.join(", ")}`).toBe(true);
    expect(new Set(r.value!.map((x) => String(x.created_at))).size, "one transaction, one time: only the sequence orders them").toBe(1);
  });

  it("🔴 a writer's own sequence number is ignored — the database numbers the row", async () => {
    const before = await asApp((c) => write(c, "A6-OWN-BEFORE"));
    expect(before.error).toBeUndefined();
    const forged = await asApp(async (c) => (await c.query(
      `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, seq) VALUES ($1, 'create', '${KIND}', 'A6-OWN', 1) RETURNING seq`, [orgId])).rows[0]!.seq);
    expect(forged.error, "a row naming its own number is written, numbered by the database").toBeUndefined();
    expect(Number(forged.value)).toBeGreaterThan(Number(before.value!.seq));
  });

  it("🔴 the Audit Trail lists the row written LATER first, whatever time an earlier writer claimed", async () => {
    expect((await asApp((c) => write(c, "A6-ORDER-EARLIER", "2030-01-01 09:00:00"))).error).toBeUndefined();
    expect((await asApp((c) => write(c, "A6-ORDER-LATER"))).error).toBeUndefined();
    const r = await h.api("admin", "GET", `/audit-logs?entity_type=${KIND}&limit=200`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ids = (r.body.logs as Array<{ entityId: string }>).map((l) => l.entityId).filter((e) => e.startsWith("A6-ORDER-"));
    expect(ids).toEqual(["A6-ORDER-LATER", "A6-ORDER-EARLIER"]);
  });

  it("🔴 the Audit Trail lists rows written in ONE transaction (one time) newest-first by the database's order", async () => {
    expect((await asApp(async (c) => { for (const k of ["A6-TX-1", "A6-TX-2", "A6-TX-3"]) await write(c, k); })).error).toBeUndefined();
    const r = await h.api("admin", "GET", `/audit-logs?entity_type=${KIND}&limit=200`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ids = (r.body.logs as Array<{ entityId: string }>).map((l) => l.entityId).filter((e) => e.startsWith("A6-TX-"));
    expect(ids).toEqual(["A6-TX-3", "A6-TX-2", "A6-TX-1"]);
  });

  it("🔴 the reader orders by the database's sequence, not by time: where the two disagree, the later-numbered row is first", async () => {
    // planted (owner, replica mode): the first-numbered row claims 2030, the next one 2020 — time and order disagree
    const plant = replica(pool as never);
    for (const [k, at] of [["A6-DISAGREE-FIRST", "2030-01-01 09:00:00"], ["A6-DISAGREE-SECOND", "2020-01-01 09:00:00"]] as const) {
      await plant.query(`INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, created_at, seq)
        VALUES ($1, 'create', '${KIND}', $2, $3, nextval('audit_logs_seq_seq'))`, [orgId, k, at]);
    }
    const r = await h.api("admin", "GET", `/audit-logs?entity_type=${KIND}&limit=200`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ids = (r.body.logs as Array<{ entityId: string }>).map((l) => l.entityId).filter((e) => e.startsWith("A6-DISAGREE-"));
    expect(ids).toEqual(["A6-DISAGREE-SECOND", "A6-DISAGREE-FIRST"]);
  });

  it("the owner's replica mode stays the one way to plant history (fixtures), as 0132 documents", async () => {
    const planted = (await replica(pool as never).query(
      `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, created_at) VALUES ($1, 'create', '${KIND}', 'A6-PLANTED', '2021-06-01 09:00:00') RETURNING created_at`, [orgId])).rows[0]!.created_at;
    expect(new Date(planted as string | Date).getUTCFullYear()).toBe(2021);
  });
});
