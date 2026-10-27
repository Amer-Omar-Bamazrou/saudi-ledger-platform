/**
 * 🔴 T1e (Phase 18; G19, G20, G57, DR-10, DR-30): closed months held at the
 * database and serialised with the close; a reopen that needs a reason and
 * keeps its history; real months only; the migration's opening month never
 * reopened, and no month of a year whose statements are authorised; and the
 * DR-10 records (filed VAT and Zakat/income-tax returns, statements authorised,
 * the awareness date on a correction), append-only. Owner decisions 2026-10-24
 * (DR-08, DR-10, DR-30), order 2026-10-27; register §11.31.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3236";
process.env.SESSION_SECRET ??= "phase18-t1e-period-controls-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18T1ePeriodControlsPw1!";

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, any>>; rowCount?: number | null }>; release: () => void };
type PgErr = { code?: string; constraint?: string; message: string };

describeMaybe("T1e — closed months at the database; reopen with a reason and history; the DR-10 records", () => {
  const h = g04Harness("p18t1e");
  let orgId = "";
  let companyId = "";
  let adminId = 0;
  let office = 0;
  let income = 0;

  const connect = async () => (await pool.connect()) as unknown as Client;
  /** A balanced draft (owner role; no source_type, as a pre-0129 row stands) and its lines. */
  const draft = async (c: Client, n: string, date: string) => {
    const { rows: [e] } = await c.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
       VALUES ($1, $2, $3, $4, 'T1e', 'draft') RETURNING id`, [orgId, companyId, n, date]);
    await c.query(
      `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4, 'Office', 10, 0), ($1, $2, $3, $5, 'Income', 0, 10)`, [orgId, companyId, e.id, office, income]);
    return e.id as number;
  };
  const flip = (c: Client, id: number) => c.query(`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1`, [id]);
  const inTx = async (fn: (c: Client) => Promise<void>): Promise<PgErr | null> => {
    const c = await connect();
    try { await c.query("BEGIN"); await fn(c); await c.query("COMMIT"); return null; }
    catch (err) { await c.query("ROLLBACK").catch(() => {}); return err as PgErr; }
    finally { c.release(); }
  };
  /** As the request's own role, in this tenant and company. */
  const asApp = async (sql: string, values: unknown[] = []): Promise<PgErr | null> => inTx(async (c) => {
    await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    await c.query(sql, values);
  });
  const lock = async (period: string) => {
    const r = await h.api("admin", "POST", "/period-locks", { period });
    expect(r.status, `close ${period}: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  };
  const account = async (code: string) =>
    Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "T1e Period Controls Co", "318181818181933");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    office = await account("OFFICE_SUPPLIES");
    income = await account("SALES");
    // A declared fiscal year (calendar), so a year's statements can be recorded as authorised.
    expect((await h.api("admin", "PATCH", "/companies/current", { fiscalYearStart: 1 })).status).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 PER-1: the database refuses to post an entry dated in a closed month, whatever wrote it; an open month posts", async () => {
    await lock("2026-03");
    const closed = await inTx(async (c) => { await flip(c, await draft(c, "T1E-CLOSED", "2026-03-15")); });
    const open = await inTx(async (c) => { await flip(c, await draft(c, "T1E-OPEN", "2026-04-15")); });
    expect([closed?.constraint, open?.message ?? null], closed?.message).toEqual(["journal_entry_period_closed", null]);
  });

  it("🔴 PER-1: a close racing a posting into that month — the posting waits for the close, then is refused", async () => {
    const closer = await connect();
    const poster = await connect();
    try {
      await closer.query("BEGIN");
      // The close path: the month's exclusive guard, then the lock row — not yet committed.
      await closer.query("SELECT period_close_guard($1::uuid, $2)", [companyId, "2026-06"]);
      await closer.query(`INSERT INTO period_locks (organization_id, company_id, period, locked_by) VALUES ($1, $2, '2026-06', $3)`, [orgId, companyId, adminId]);
      await poster.query("BEGIN");
      const pid = (await poster.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const id = await draft(poster, "T1E-RACE", "2026-06-10");
      const posting = flip(poster, id).then(() => null, (e: PgErr) => e);
      // The posting is WAITING on the close (its own backend only — never a database-wide count).
      let waited = false;
      for (let i = 0; i < 50 && !waited; i++) {
        const w = (await pool.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid])).rows[0]?.wait_event_type;
        waited = w === "Lock";
        if (!waited) await new Promise((r) => setTimeout(r, 50));
      }
      await closer.query("COMMIT");
      const err = await posting;
      await poster.query("ROLLBACK").catch(() => {});
      expect([waited, err?.constraint], err?.message).toEqual([true, "journal_entry_period_closed"]);
    } finally {
      closer.release();
      poster.release();
    }
  });

  it("🔴 PER-2: a reopen needs a reason, keeps the lock row and its history, and a re-close adds to it; nothing deletes a lock", async () => {
    await lock("2026-05");
    const noReason = await h.api("admin", "POST", "/period-locks/2026-05/reopen", {});
    expect([noReason.status, noReason.body.code]).toEqual([422, "reopen_reason_required"]);
    const del = await h.api("admin", "DELETE", "/period-locks/2026-05");
    expect([del.status, del.body.code], "the old reopen door names the new one").toEqual([422, "reopen_requires_reason"]);
    const ok = await h.api("admin", "POST", "/period-locks/2026-05/reopen", { reason: "Late supplier invoice for May" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(((await h.api("admin", "GET", "/period-locks")).body as Array<{ period: string }>).map((l) => l.period), "a reopened month is not closed").not.toContain("2026-05");
    const row = (await pool.query(`SELECT reopened_by, reopen_reason FROM period_locks WHERE company_id = $1 AND period = '2026-05'`, [companyId])).rows[0];
    expect(row, "the lock row stays").toEqual({ reopened_by: adminId, reopen_reason: "Late supplier invoice for May" });
    await lock("2026-05");
    const hist = await h.api("admin", "GET", "/period-locks/2026-05/history");
    expect(hist.status, JSON.stringify(hist.body)).toBe(200);
    expect((hist.body as Array<{ event: string; reason: string | null; actor: number }>).map((e) => [e.event, e.reason, e.actor])).toEqual([
      ["close", null, adminId], ["reopen", "Late supplier invoice for May", adminId], ["close", null, adminId],
    ]);
    // The request's role cannot delete a lock, nor change or delete its history.
    expect((await asApp(`DELETE FROM period_locks WHERE period = '2026-05'`))?.code).toBe("42501");
    expect((await asApp(`DELETE FROM period_lock_events WHERE period = '2026-05'`))?.code).toBe("42501");
    expect((await asApp(`UPDATE period_lock_events SET reason = 'x' WHERE period = '2026-05'`))?.code).toBe("42501");
  });

  it("🔴 a period is a real month: 2026-13 is refused by the API and by the database", async () => {
    const r = await h.api("admin", "POST", "/period-locks", { period: "2026-13" });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    const db = await inTx(async (c) => { await c.query(`INSERT INTO period_locks (organization_id, company_id, period) VALUES ($1, $2, '2026-13')`, [orgId, companyId]); });
    expect(db?.constraint, db?.message).toBe("period_locks_period_chk");
  });

  it("🔴 G57: the migration's opening month is never reopened, with or without a reason", async () => {
    const lockId = await lock("2025-11");
    await pool.query(
      `INSERT INTO migration_batches (organization_id, company_id, status, source_system, cutover_date, opening_date, period_lock_id)
       VALUES ($1, $2, 'committed', 'T1E', '2025-12-01', '2025-11-30', $3)`, [orgId, companyId, lockId]);
    const r = await h.api("admin", "POST", "/period-locks/2025-11/reopen", { reason: "try" });
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([422, "opening_month_never_reopened"]);
    expect((await pool.query(`SELECT reopened_at FROM period_locks WHERE id = $1`, [lockId])).rows[0].reopened_at).toBeNull();
  });

  it("🔴 DR-30: no month of a year whose statements are authorised is reopened; another year's month is", async () => {
    const auth = await h.api("admin", "POST", "/statement-authorisations", { fiscalYearEnd: "2025-12-31", authorisedOn: "2026-03-01", authorisedBy: "Board of directors" });
    expect(auth.status, JSON.stringify(auth.body)).toBe(201);
    await lock("2025-07");
    const refused = await h.api("admin", "POST", "/period-locks/2025-07/reopen", { reason: "Found an error" });
    expect([refused.status, refused.body.code], JSON.stringify(refused.body)).toEqual([422, "statements_authorised"]);
    await lock("2026-07");
    expect((await h.api("admin", "POST", "/period-locks/2026-07/reopen", { reason: "Found an error" })).status).toBe(200);
  });

  it("🔴 DR-10: filed VAT and Zakat/income-tax returns and the statements' authorisation are recorded, and never changed or deleted", async () => {
    const vat = await h.api("admin", "POST", "/tax/vat-return-filings", { periodFrom: "2026-01", periodTo: "2026-03", filedOn: "2026-04-20", zatcaReference: "VAT-T1E-0001" });
    expect(vat.status, JSON.stringify(vat.body)).toBe(201);
    const zak = await h.api("admin", "POST", "/tax/zakat-income-tax-filings", { kind: "zakat", fiscalYearEnd: "2025-12-31", filedOn: "2026-04-30", zatcaReference: "ZKT-T1E-0001" });
    expect(zak.status, JSON.stringify(zak.body)).toBe(201);
    expect(((await h.api("admin", "GET", "/tax/vat-return-filings")).body as Array<{ zatcaReference: string }>).map((f) => f.zatcaReference)).toContain("VAT-T1E-0001");
    expect(((await h.api("admin", "GET", "/tax/zakat-income-tax-filings")).body as Array<{ zatcaReference: string }>).map((f) => f.zatcaReference)).toContain("ZKT-T1E-0001");
    expect(((await h.api("admin", "GET", "/statement-authorisations")).body as Array<{ authorisedBy: string }>).map((a) => a.authorisedBy)).toContain("Board of directors");
    for (const t of ["vat_return_filings", "zakat_income_tax_filings", "statement_authorisations"]) {
      expect((await asApp(`UPDATE ${t} SET notes = 'x'`))?.code, `${t} UPDATE`).toBe("42501");
      expect((await asApp(`DELETE FROM ${t}`))?.code, `${t} DELETE`).toBe("42501");
    }
  });

  it("🔴 DR-10 / owner decision 10: a correction records the actual discovery date, any earlier apparent date apart, and its evidence", async () => {
    const je = await h.api("admin", "POST", "/journal-entries", { date: "2026-08-05", description: "T1e original", lines: [
      { accountId: office, accountName: "Office", debitAmount: 70, creditAmount: 0 },
      { accountId: income, accountName: "Income", debitAmount: 0, creditAmount: 70 },
    ] });
    expect(je.status, JSON.stringify(je.body)).toBe(201);
    expect((await h.api("admin", "POST", `/journal-entries/${je.body.id}/approve`, {})).status).toBe(200);
    const r = await h.api("admin", "POST", `/journal-entries/${je.body.id}/reverse`, {
      reason: "Posted to the wrong account", discoveredOn: "2026-09-10", apparentOn: "2026-08-20", discoveryEvidence: "Bank reconciliation of August",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = (await pool.query(`SELECT to_jsonb(j.*) AS j FROM journal_entries j WHERE id = $1`, [r.body.reversalId])).rows[0].j;
    expect([m.discovered_on, m.apparent_on, m.discovery_evidence]).toEqual(["2026-09-10", "2026-08-20", "Bank reconciliation of August"]);
  });
});
