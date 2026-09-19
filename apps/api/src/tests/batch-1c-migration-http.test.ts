/**
 * BATCH 1C — the migration API over HTTP: reachable, permission-gated by
 * role exactly as decided (admin runs it, accountant reads it, bookkeeper and
 * viewer see nothing), and every response PARSED against the generated
 * contract (a spec entry nobody has parsed a response against is a claim).
 */
process.env.PORT ??= "3000";
process.env.SESSION_SECRET ??= "test-secret-value-at-least-32-chars!!";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import {
  CreateMigrationBatchResponse, GetMigrationBatchResponse, UpdateMigrationBatchResponse, ImportMigrationChartResponse,
  ImportMigrationPartiesResponse, DecideMigrationPartyResponse, ImportMigrationOpenItemsResponse, ImportMigrationAdvancesResponse,
  GetMigrationOpeningPositionResponse, ValidateMigrationBatchResponse, GetMigrationPartiesResponse, ListMigrationBatchesResponse,
} from "@workspace/api-zod";
import { primePermissionCache } from "../lib/rbac";
import { __resetRateLimitsForTests } from "../routes/auth";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "b1c-http";
const PASSWORD = "b1c-http-pw-1234";
const USERS = { admin: "b1c-http-admin@test.local", accountant: "b1c-http-acct@test.local", bookkeeper: "b1c-http-book@test.local", viewer: "b1c-http-view@test.local" } as const;

describeMaybe("Batch 1C — the migration API over HTTP: roles and the generated contract", () => {
  let orgId = "", companyId = "";
  let server: http.Server;
  let base = "";
  let cookie = "";
  let bankId = 0;

  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      const emails = Object.values(USERS).map((e) => `'${e}'`).join(",");
      for (const t of ["migration_advances", "migration_open_items", "migration_parties", "migration_chart_rows", "migration_batches", "audit_logs", "organization_memberships", "bank_accounts", "customers", "vendors", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email IN (${emails}))`);
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email IN (${emails})`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const sid = setCookies.find((c) => c.startsWith("ksa_ledger_sid="));
    if (sid) cookie = sid.split(";")[0];
    let json: unknown;
    try { json = await res.json(); } catch { json = undefined; }
    return { status: res.status, body: json as never };
  }
  const loginAs = async (role: keyof typeof USERS) => {
    cookie = "";
    const r = await api("POST", "/auth/login", { email: USERS[role], password: PASSWORD });
    expect(r.status, `login as ${role}`).toBe(200);
  };

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('B1C HTTP','${SLUG}','approved') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start) VALUES ($1,'B1C HTTP Co','1010858381','399999999999913',1) RETURNING id`, [orgId])).rows[0].id;
    const hash = await bcrypt.hash(PASSWORD, 4);
    for (const [role, email] of Object.entries(USERS)) {
      const uid = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email, role, hash])).rows[0].id;
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,'active')`, [uid, orgId, role]);
    }
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  it("🔴 admin walks the whole Phase 1 + 2 surface over HTTP, and every response parses against the generated contract", async () => {
    await loginAs("admin");
    // A bank through the product's own path (D-3 creates its leaf).
    const bank = await api("POST", "/bank-accounts", { name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR", balance: 0, openingBalance: 0 });
    expect(bank.status).toBe(201);
    bankId = (bank.body as { id: number }).id;

    const created = await api("POST", "/migration/batches", { sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" });
    expect(created.status).toBe(201);
    const batch = CreateMigrationBatchResponse.parse(created.body);
    expect(batch.openingDate).toBe("2026-06-30");
    const id = batch.id;
    ListMigrationBatchesResponse.parse((await api("GET", "/migration/batches")).body);

    const chart = await api("PUT", `/migration/batches/${id}/chart`, { rows: [
      { sourceCode: "1100", sourceName: "Riyad Bank", sourceType: "asset", openingDebit: 1150, sourceRole: "bank", evidenceNote: "statement 30 Jun" },
      { sourceCode: "1200", sourceName: "Debtors", sourceType: "asset", openingDebit: 1000, sourceRole: "receivable" },
      { sourceCode: "2300", sourceName: "Advances", sourceType: "liability", openingCredit: 150, sourceRole: "customer_deposits" },
      { sourceCode: "3100", sourceName: "Capital", sourceType: "equity", openingCredit: 2000 },
    ] });
    expect(chart.status).toBe(200);
    const chartOut = ImportMigrationChartResponse.parse(chart.body);
    expect(chartOut.summary.balanced).toBe(true);
    const rowId = (code: string) => chartOut.rows.find((r) => r.sourceCode === code)!.id;
    expect((await api("PATCH", `/migration/batches/${id}/chart/${rowId("1100")}`, { decision: "map_to_bank", targetBankAccountId: bankId })).status).toBe(200);
    expect((await api("PATCH", `/migration/batches/${id}/chart/${rowId("1200")}`, { decision: "map_to_system", targetSystemCode: "AR" })).status).toBe(200);
    expect((await api("PATCH", `/migration/batches/${id}/chart/${rowId("2300")}`, { decision: "map_to_system", targetSystemCode: "CUSTOMER_DEPOSITS" })).status).toBe(200);
    expect((await api("PATCH", `/migration/batches/${id}/chart/${rowId("3100")}`, { decision: "create" })).status).toBe(200);
    // The spec's constraint is the server's: an unknown decision is a 400 from the generated schema, not a 500.
    expect((await api("PATCH", `/migration/batches/${id}/chart/${rowId("3100")}`, { decision: "delete" })).status).toBe(400);

    const parties = await api("PUT", `/migration/batches/${id}/parties`, { rows: [{ partyType: "customer", sourceId: "C1", name: "Alpha" }] });
    expect(parties.status).toBe(200);
    const partiesOut = ImportMigrationPartiesResponse.parse(parties.body);
    expect(partiesOut.rows[0].decision).toBe("create");
    DecideMigrationPartyResponse.parse((await api("PATCH", `/migration/batches/${id}/parties/${partiesOut.rows[0].id}`, { decision: "create" })).body);
    expect((await api("PATCH", `/migration/batches/${id}/parties/${partiesOut.rows[0].id}`, { decision: "use_existing", existingId: 999999 })).status).toBe(422);

    const items = await api("PUT", `/migration/batches/${id}/open-items`, { rows: [
      { itemType: "ar", sourceId: "SI-1", partySourceId: "C1", documentNumber: "INV-1", issueDate: "2026-06-01", dueDate: "2026-06-30", originalAmount: 1000, outstandingAmount: 1000 },
    ] });
    expect(items.status).toBe(200);
    expect(ImportMigrationOpenItemsResponse.parse(items.body).summary.ar.total).toBe(1000);
    expect((await api("PUT", `/migration/batches/${id}/open-items`, { rows: [] })).status).toBe(400); // minItems is enforced

    const advances = await api("PUT", `/migration/batches/${id}/advances`, { rows: [
      { sourceId: "ADV-1", partySourceId: "C1", bankSourceCode: "1100", amount: 150, receivedAt: "2026-06-10", vatPosition: "unknown" },
    ] });
    expect(advances.status).toBe(200);
    expect(ImportMigrationAdvancesResponse.parse(advances.body).summary.unknown).toBe(1);

    const patched = await api("PATCH", `/migration/batches/${id}`, { notes: "walked over HTTP" });
    expect(patched.status).toBe(200);
    expect(UpdateMigrationBatchResponse.parse(patched.body).notes).toBe("walked over HTTP");
    expect((await api("PATCH", `/migration/batches/${id}`, { vatPosition: { returnReference: "X", periodStart: "2026-04-01", periodEnd: "2026-07-31", outputVatPayable: 0, inputVatReceivable: 0 } })).status).toBe(400);

    const position = await api("GET", `/migration/batches/${id}/opening-position`);
    expect(position.status).toBe(200);
    const pos = GetMigrationOpeningPositionResponse.parse(position.body);
    expect(pos.totals).toMatchObject({ debit: 2150, credit: 2150, balanced: true, openingBalanceEquity: 0 });
    expect(pos.arByCustomer).toEqual([{ partySourceId: "C1", partyName: "Alpha", items: 1, total: 1000 }]);

    const validated = await api("POST", `/migration/batches/${id}/validate`);
    expect(validated.status).toBe(200);
    const v = ValidateMigrationBatchResponse.parse(validated.body);
    expect(v.checks.filter((c) => c.status === "fail").map((c) => c.id), v.checks.map((c) => `${c.id}:${c.status} ${c.detail}`).join("\n")).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.status).toBe("validated");
    const detail = GetMigrationBatchResponse.parse((await api("GET", `/migration/batches/${id}`)).body);
    expect(detail.status).toBe("validated");
    expect(detail.counts).toEqual({ chartRows: 4, chartRowsUnmapped: 0, parties: 1, openItems: 1, advances: 1 });
  });

  it("🔴 roles: accountant reads and cannot write; bookkeeper and viewer cannot even read", async () => {
    await loginAs("accountant");
    const list = await api("GET", "/migration/batches");
    expect(list.status).toBe(200);
    const id = ListMigrationBatchesResponse.parse(list.body)[0].id;
    expect((await api("GET", `/migration/batches/${id}/parties`)).status).toBe(200);
    GetMigrationPartiesResponse.parse((await api("GET", `/migration/batches/${id}/parties`)).body);
    expect((await api("GET", `/migration/batches/${id}/opening-position`)).status).toBe(200);
    expect((await api("POST", "/migration/batches", { sourceSystem: "X", cutoverDate: "2026-07-01" })).status).toBe(403);
    expect((await api("PUT", `/migration/batches/${id}/parties`, { rows: [{ partyType: "customer", sourceId: "C9", name: "Nope" }] })).status).toBe(403);
    expect((await api("PATCH", `/migration/batches/${id}`, { notes: "nope" })).status).toBe(403);
    expect((await api("POST", `/migration/batches/${id}/validate`)).status).toBe(403);
    expect((await api("POST", `/migration/batches/${id}/discard`)).status).toBe(403);
    for (const role of ["bookkeeper", "viewer"] as const) {
      await loginAs(role);
      expect((await api("GET", "/migration/batches")).status, role).toBe(403);
      expect((await api("GET", `/migration/batches/${id}/open-items`)).status, role).toBe(403);
      expect((await api("PUT", `/migration/batches/${id}/advances`, { rows: [] })).status, role).toBe(403);
    }
    // Nothing the refused calls did reached the batch.
    await loginAs("admin");
    const detail = GetMigrationBatchResponse.parse((await api("GET", `/migration/batches/${id}`)).body);
    expect(detail.status).toBe("validated");
    expect(detail.counts.parties).toBe(1);
  });
});
