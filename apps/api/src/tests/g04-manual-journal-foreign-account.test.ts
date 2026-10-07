/**
 * G04 PROOF (owner amendment B, 2026-10-07) — PROOF ONLY, NOT A FIX.
 *
 * The question: does a manual journal entry accept a line whose `accountId`
 * belongs to ANOTHER tenant's chart of accounts?
 *
 * Why it could: `journalEntriesService.create` resolves the line accounts
 * through the RLS-scoped `categoriesRepository.findByIds`, and only REFUSES
 * accounts it FOUND (a header, a control account without its party). An id
 * the tenant cannot see is simply not found, so no rule runs on it — and the
 * `journal_entry_lines.account_id → categories.id` foreign key is checked
 * outside RLS (CLAUDE.md §3, "FK checks run OUTSIDE RLS").
 *
 * This file asserts the SAFE behaviour (refusal). On the code as it stands
 * it is expected to FAIL; a failure is the reproduction. The fix is the
 * owner's decision and is not part of this batch.
 *
 * 🔴 KNOWN-FAILING BY DESIGN (owner decision, 2026-10-07). It lives on
 * branch `fix/g04-cross-tenant-account` only — committed as the red test the
 * G04 investigation starts from, and never on `main` until the fix makes it
 * green. Reproduced on main d828f786: another tenant's account id was
 * accepted (201), approved (200) and POSTED; a nonexistent id answered a raw
 * 500 (so 201-vs-500 discloses whether an id exists in another tenant).
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3112";
process.env.SESSION_SECRET ??= "g04-manual-journal-proof-test-session-secret-1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { __resetRateLimitsForTests } from "../routes/auth";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "G04ProofPw123!";
const P = "g04mj";
const email = (k: string) => `${P}-${k}@test.local`;

describeMaybe("G04 proof — a manual journal line naming another tenant's account", () => {
  let server: http.Server;
  let base = "";
  let orgX = "";
  let orgY = "";
  let ownExpense = 0;
  let ownIncome = 0;
  let foreignExpense = 0;

  const ORG_FILTER = `(SELECT id FROM organizations WHERE slug LIKE '${P}-%')`;
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const t of ["journal_entry_lines", "journal_entries", "audit_logs", "organization_memberships", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${ORG_FILTER}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug LIKE '${P}-%'`);
      await client.query(`DELETE FROM users WHERE email LIKE '${P}-%'`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  let cookie = "";
  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = ((res.headers as any).getSetCookie?.() ?? []).find((c: string) => c.startsWith("ksa_ledger_sid="));
    if (sid) cookie = sid.split(";")[0];
    let json: any;
    try { json = await res.json(); } catch { json = undefined; }
    return { status: res.status, body: json };
  }

  // Ordinary posting accounts from the seeded chart — no party, no bank, no tax guard.
  const accountOf = async (org: string, systemCode: string) =>
    (await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`,
      [org, systemCode],
    )).rows[0].id as number;
  const jeCount = async () =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgX])).rows[0].n);

  const entry = (n: string, debitAccount: number) => ({
    entryNumber: n,
    date: "2026-10-01",
    description: "G04 proof",
    lines: [
      { accountId: debitAccount, accountName: "debit", debitAmount: 100, creditAmount: 0 },
      { accountId: ownIncome, accountName: "credit", debitAmount: 0, creditAmount: 100 },
    ],
  });

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    orgX = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('G04 X','${P}-x','approved') RETURNING id`)).rows[0].id;
    orgY = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('G04 Y','${P}-y','approved') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1,'G04 X Co',1)`, [orgX]);
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1,'G04 Y Co',1)`, [orgY]);
    ownExpense = await accountOf(orgX, "RENT_UTILITIES");
    ownIncome = await accountOf(orgX, "OTHER_INCOME");
    foreignExpense = await accountOf(orgY, "RENT_UTILITIES");
    const hash = await bcrypt.hash(PW, 4);
    const uid = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'G04 Admin',$2,'viewer',true) RETURNING id`, [email("admin"), hash])).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [uid, orgX]);
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    expect((await api("POST", "/auth/login", { email: email("admin"), password: PW })).status).toBe(200);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  it("PREMISE: a manual journal on the tenant's own accounts is accepted (anti-vacuity)", async () => {
    expect(foreignExpense).not.toBe(ownExpense);
    const r = await api("POST", "/journal-entries", entry("G04-OWN", ownExpense));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("🔴 PROOF: a line naming ANOTHER tenant's account id is refused, and nothing is written", async () => {
    const before = await jeCount();
    const r = await api("POST", "/journal-entries", entry("G04-FOREIGN", foreignExpense));
    if (r.status === 201) {
      // Evidence for the report, recorded before the assertion fails.
      const approved = await api("POST", `/journal-entries/${r.body.id}/approve`, {});
      const line = (await pool.query(
        `SELECT l.account_id, c.organization_id AS account_org, je.status, je.organization_id AS entry_org
           FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id JOIN journal_entries je ON je.id = l.journal_entry_id
          WHERE l.journal_entry_id = $1 AND l.debit_amount > 0`,
        [r.body.id],
      )).rows[0];
      // eslint-disable-next-line no-console
      console.warn("[G04 PROOF] foreign-account entry", JSON.stringify({ create: r.status, approve: approved.status, line, orgX, orgY }));
    }
    expect(r.status, "another tenant's account must be refused").toBe(422);
    expect(await jeCount()).toBe(before);
  });

  it("🔴 PROOF: a line naming a NONEXISTENT account id is refused the same way (no existence oracle)", async () => {
    const r = await api("POST", "/journal-entries", entry("G04-MISSING", 2_000_000_000));
    expect(r.status).toBe(422);
  });
});
