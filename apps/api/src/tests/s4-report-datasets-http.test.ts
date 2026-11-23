/**
 * 🔴 19B S4 (control 19B-S4) — the journal-lines dataset over HTTP, on rows the product wrote (a bank row posted from a transaction, and
 * a typed journal entry), and D6's refusal events.
 *
 *  - RUN: the dataset's lines are the ledger's — the same debit total the journal report answers for the window (one
 *    figure, two paths, non-zero); the total is the true count; the page is paged.
 *  - WITHHOLDING (a matrix where the viewer lacks the bank-text grant): the bank line's text is ABSENT from its row and
 *    listed; the typed line's text is still there (presence, absence, movement); a sort on it is refused by name.
 *  - EXPORT: a CSV of the same rows, recorded in the audit trail; the bank line's text marked, the typed one kept.
 *  - REFUSAL EVENTS (D6): a refused export, and a refused field write, are recorded — names and classes, NEVER a value
 *    (a planted value is nowhere in the row) — on their own connection, so they survive the refused request; a failed
 *    record is alarmed and the refusal still stands. The table is append-only and the application's role holds nothing.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3242";
process.env.SESSION_SECRET ??= "s4-report-datasets-http-000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, PERMISSION_MATRIX, reportDatasetResource, type PermissionRow } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { refusalEventsStore } from "../services/refusalEvents.service";
import { alerter } from "../lib/alerter";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s4-report-datasets-password-2026";
const BANK_TEXT = "S4 BANK SARIE TRANSFER REF 7711";
const TYPED_TEXT = "S4 typed accrual";
const ROWS = "/reports/datasets/journal_lines/rows";
const EXPORT = "/reports/datasets/journal_lines/export";
const h = g04Harness("s4ds");

const without = (pred: (r: PermissionRow) => boolean) => PERMISSION_MATRIX.filter((r) => !pred(r));
const noViewerBankText = without((r) => r.role === "viewer" && r.resource === "journal_entries" && r.action === "field.bank_narrative.read");
const noViewerExport = without((r) => r.role === "viewer" && r.resource === reportDatasetResource("journal_lines") && r.action === "export");

describeDb("19B S4 — the journal-lines dataset, and the refusal events", () => {
  let orgId = "";
  let companyId = "";
  const ids: Record<string, number> = {};
  const events = async () =>
    (await pool.query(`SELECT * FROM permission_refusal_events WHERE organization_id = $1 ORDER BY id`, [orgId])).rows;

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "S4 Dataset Co", "319191919191953");
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) ids[role] = await h.mkUser(role, PW, orgId, role);
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) expect(await h.login(role, h.email(role), PW)).toBe(200);
    const acct = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "S4 Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    const row = await h.api("admin", "POST", "/transactions", { date: "2026-10-10", description: BANK_TEXT, amount: 120, currency: "SAR", type: "debit", categoryId: await acct("RENT_UTILITIES"), bankAccountId: bank.body.id });
    expect(row.status, JSON.stringify(row.body)).toBe(201);
    const je = await h.api("admin", "POST", "/journal-entries", { date: "2026-10-15", description: TYPED_TEXT, lines: [
      { accountId: await acct("RENT_UTILITIES"), accountName: "Rent & Utilities", debitAmount: 50, creditAmount: 0, description: TYPED_TEXT },
      { accountId: await acct("ACCRUED_LIABILITIES"), accountName: "Accrued Liabilities", debitAmount: 0, creditAmount: 50, description: TYPED_TEXT },
    ] });
    expect(je.status, JSON.stringify(je.body)).toBe(201);
    expect((await h.api("admin", "POST", `/journal-entries/${je.body.id}/approve`, {})).status).toBe(200);
    const sources = (await pool.query(`SELECT DISTINCT source_type FROM journal_entries WHERE organization_id = $1`, [orgId])).rows.map((r) => r.source_type).sort();
    expect(sources).toEqual(["bank_transaction", "manual"]); // the fixture really has both kinds
  }, 120_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); vi.restoreAllMocks(); await h.stop(); await h.cleanup(); });

  it("🔴 the list: the viewer's acts on journal lines are v4 §6.2's, and every column is read under the matrix", async () => {
    primePermissionCache(PERMISSION_MATRIX);
    const r = await h.api("viewer", "GET", "/reports/datasets");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const jl = r.body.items.find((i: { name: string }) => i.name === "journal_lines");
    expect(jl.acts).toEqual(["run", "export", "schedule", "save"]);
    expect(jl.columns.every((c: { level: string }) => c.level === "read")).toBe(true);
  });

  it("🔴 the rows are the ledger's: the debit total equals the journal report's for the window — non-zero, two paths", async () => {
    primePermissionCache(PERMISSION_MATRIX);
    const r = await h.api("viewer", "GET", `${ROWS}?date_from=2026-10-01&date_to=2026-10-31&limit=500`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const sum = (r.body.rows as { debit: number }[]).reduce((s, x) => s + x.debit, 0);
    const journal = await h.api("viewer", "GET", "/reports/journal-report?date_from=2026-10-01&date_to=2026-10-31");
    expect(journal.status).toBe(200);
    expect([sum, r.body.total]).toEqual([journal.body.grandDebit, r.body.rows.length]);
    expect(sum).toBe(170); // 120 from the bank row, 50 typed
    const paged = await h.api("viewer", "GET", `${ROWS}?date_from=2026-10-01&date_to=2026-10-31&limit=1&offset=1&sort=-debit`);
    expect([paged.body.rows.length, paged.body.total]).toEqual([1, r.body.total]); // the total is the true count, not the page
  });

  it("🔴 without the bank-text grant: the bank line's text is ABSENT and listed, the typed line's text stays; a sort on it is refused by name", async () => {
    primePermissionCache(PERMISSION_MATRIX);
    const before = await h.api("viewer", "GET", `${ROWS}?date_from=2026-10-01&date_to=2026-10-31&columns=sourceType,description,debit`);
    expect((before.body.rows as { description?: string }[]).map((x) => x.description).sort()).toEqual([BANK_TEXT, BANK_TEXT, TYPED_TEXT, TYPED_TEXT].sort());
    primePermissionCache(noViewerBankText);
    const r = await h.api("viewer", "GET", `${ROWS}?date_from=2026-10-01&date_to=2026-10-31&columns=sourceType,description,debit`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const bankRows = (r.body.rows as Record<string, unknown>[]).filter((x) => x.sourceType === "bank_transaction");
    const typedRows = (r.body.rows as Record<string, unknown>[]).filter((x) => x.sourceType === "manual");
    expect(bankRows.length).toBeGreaterThan(0);
    expect(bankRows.every((x) => !("description" in x))).toBe(true); // absent — never blank or null
    expect(typedRows.map((x) => x.description)).toEqual([TYPED_TEXT, TYPED_TEXT]); // the typed text moves through
    expect(r.text.includes(BANK_TEXT)).toBe(false);
    expect(r.body.withheld).toEqual([{ path: "rows[].description", class: "bank_narrative", level: "none", rows: bankRows.length }]);
    expect(r.body.columns.find((c: { key: string }) => c.key === "description")).toMatchObject({ level: "none", class: "bank_narrative" });
    // asked for the line text ALONE: the source comes with it, so the typed text is still served — by the dataset AND the seam
    const alone = await h.api("viewer", "GET", `${ROWS}?date_from=2026-10-01&date_to=2026-10-31&columns=description`);
    expect(alone.body.columns.map((c: { key: string }) => c.key)).toEqual(["description", "sourceType"]);
    expect((alone.body.rows as Record<string, unknown>[]).filter((x) => "description" in x).map((x) => [x.sourceType, x.description])).toEqual([["manual", TYPED_TEXT], ["manual", TYPED_TEXT]]);
    // a filter id past the column's range is a 400 by name, never a database error
    const huge = await h.api("viewer", "GET", `${ROWS}?account_id=99999999999`);
    expect([huge.status, huge.body.code]).toEqual([400, "report_bad_filter"]);
    const sorted = await h.api("viewer", "GET", `${ROWS}?sort=description`);
    expect([sorted.status, sorted.body.code, sorted.body.fields]).toEqual([403, "report_field_withheld", [{ field: "description", class: "bank_narrative", use: "sort" }]]);
    expect(await events()).toEqual([]); // a refused RUN is not a refusal event (D6)
    // the accountant keeps the grant: the same request still shows the bank text
    const acc = await h.api("accountant", "GET", `${ROWS}?date_from=2026-10-01&date_to=2026-10-31&columns=sourceType,description`);
    expect(acc.text.includes(BANK_TEXT)).toBe(true);
    primePermissionCache(PERMISSION_MATRIX);
  });

  it("🔴 the export: the same rows as CSV, recorded before it is sent; the bank text marked for a role without its grant", async () => {
    primePermissionCache(noViewerBankText);
    const r = await h.api("viewer", "GET", `${EXPORT}?date_from=2026-10-01&date_to=2026-10-31&columns=date,description,debit,credit`);
    expect(r.status, r.text).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.text).not.toContain(BANK_TEXT);
    expect(r.text).toContain("[withheld: bank text]");
    expect(r.text).toContain(TYPED_TEXT);
    const audit = (await pool.query(`SELECT entity_id, after_state FROM audit_logs WHERE organization_id = $1 AND entity_type = 'report_dataset_export' ORDER BY created_at DESC LIMIT 1`, [orgId])).rows[0];
    expect([audit.entity_id, audit.after_state.rows, audit.after_state.withheldCells]).toEqual(["journal_lines", 4, 2]);
    primePermissionCache(PERMISSION_MATRIX);
  });

  it("🔴 D6: a refused export is RECORDED — the act, the dataset, the code; a planted value is nowhere in the event", async () => {
    primePermissionCache(noViewerExport);
    const PLANT = "S4CANARY-55813";
    const r = await h.api("viewer", "GET", `${EXPORT}?date_from=2026-10-01&source_type=${PLANT}`);
    expect([r.status, r.body.code]).toEqual([403, "report_act_not_granted"]);
    const ev = await events();
    expect(ev.map((e) => [e.action, e.resource, e.refusal_code, e.actor_user_id, e.company_id])).toEqual([["export", "report_dataset.journal_lines", "report_act_not_granted", ids.viewer, companyId]]);
    expect(JSON.stringify(ev).includes(PLANT)).toBe(false);
    primePermissionCache(noViewerBankText);
    const sortRefused = await h.api("viewer", "GET", `${EXPORT}?sort=description`);
    expect([sortRefused.status, sortRefused.body.code]).toEqual([403, "report_field_withheld"]);
    const last = (await events()).at(-1);
    expect([last.refusal_code, last.field_names, last.field_classes]).toEqual(["report_field_withheld", ["description"], ["bank_narrative"]]);
    primePermissionCache(PERMISSION_MATRIX);
  });

  it("🔴 D6: a refused FIELD WRITE is recorded — the field and its class, never what was typed", async () => {
    const emp = await h.api("accountant", "POST", "/employees", { employeeNumber: "S4-E1", name: "S4 Employee" });
    expect(emp.status, JSON.stringify(emp.body)).toBe(201);
    const PLANT_SALARY = 98765.43;
    const r = await h.api("bookkeeper", "PATCH", `/employees/${emp.body.id}`, { basicSalary: PLANT_SALARY });
    expect([r.status, r.body.code]).toEqual([403, "field_write_not_granted"]);
    const ev = (await events()).filter((e) => e.action === "field_write");
    expect(ev.map((e) => [e.resource, e.refusal_code, e.field_names, e.field_classes, e.actor_user_id])).toEqual([["employees", "field_write_not_granted", ["basicSalary"], ["compensation"], ids.bookkeeper]]);
    expect(JSON.stringify(ev).includes("98765")).toBe(false);
    expect((await pool.query(`SELECT basic_salary FROM employees WHERE id = $1`, [emp.body.id])).rows[0].basic_salary).toBeNull();
  });

  it("🔴 a failed record is ALARMED and the refusal still stands", async () => {
    const before = (await events()).length;
    const store = vi.spyOn(refusalEventsStore, "insert").mockRejectedValueOnce(new Error("planted store failure"));
    const page = vi.spyOn(alerter, "fire");
    primePermissionCache(noViewerExport);
    const r = await h.api("viewer", "GET", EXPORT);
    expect([r.status, r.body.code]).toEqual([403, "report_act_not_granted"]);
    expect(store).toHaveBeenCalledTimes(1);
    expect(page.mock.calls.map((c) => c[0].key)).toContain("refusal-event-write-failed");
    expect((await events()).length).toBe(before); // nothing recorded — and nothing else changed
    primePermissionCache(PERMISSION_MATRIX);
    store.mockRestore();
    page.mockRestore();
  });

  it("🔴 the table: append-only for the owner too, and the application's role holds nothing on it", async () => {
    const [first] = await events();
    expect(first).toBeTruthy();
    await expect(pool.query(`UPDATE permission_refusal_events SET refusal_code = 'x' WHERE id = $1`, [first.id])).rejects.toMatchObject({ constraint: "audit_log_append_only" });
    await expect(pool.query(`DELETE FROM permission_refusal_events WHERE id = $1`, [first.id])).rejects.toMatchObject({ constraint: "audit_log_append_only" });
    const grants = (await pool.query(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'permission_refusal_events' AND grantee IN ('authenticated', 'anon', 'service_role', 'PUBLIC')`,
    )).rows;
    expect(grants).toEqual([]);
    // its time is the database's, whatever the writer names
    await pool.query(`INSERT INTO permission_refusal_events (organization_id, action, resource, refusal_code, occurred_at) VALUES ($1, 'export', 'x', 'y', '2001-01-01')`, [orgId]);
    const planted = (await pool.query(`SELECT occurred_at FROM permission_refusal_events WHERE organization_id = $1 AND resource = 'x'`, [orgId])).rows[0];
    expect(new Date(planted.occurred_at).getUTCFullYear()).toBeGreaterThan(2001);
  });
});
