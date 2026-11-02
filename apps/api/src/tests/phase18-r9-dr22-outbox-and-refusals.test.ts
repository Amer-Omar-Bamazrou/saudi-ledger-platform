/**
 * 🔴 Phase 18 R-9 — DR-22, finished (memo §2b; register §11.106):
 *   A. every ZATCA outbox TRANSITION is recorded in the audit trail — by the
 *      database, so every writer (claim, reclaim, accept, fail) is covered;
 *      never the signed XML; the worker has no user;
 *   B. every cross-tenant REFERENCE REFUSAL answered to a request is recorded
 *      in the security trail — the field and the id asked for, never whether
 *      it exists elsewhere (G04: foreign ≡ missing).
 * Each record sits beside a control that records nothing.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3219";
process.env.SESSION_SECRET ??= "r9-dr22-outbox-and-refusals-00000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { until } from "./helpers/g08rRace";
import { writeIssuedFixture } from "./helpers/issuedInvoiceFixtures";
import { einvoiceOutboxRepository } from "../repositories/einvoiceOutbox.repository";
import { errorHandler } from "../middleware/errorHandler";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "R9AuditPw123!";
const DATE = "2026-06-15";
const SIGNED_XML = "<Invoice>R9-SIGNED-XML</Invoice>";

describeMaybe("Phase 18 R-9 (DR-22) — the outbox's transitions and the cross-tenant refusals are recorded", () => {
  const h = g04Harness("r9audit");
  let orgA = "";
  let coA = "";
  let orgB = "";
  let adminA = 0;
  let customerA = 0;
  let customerB = 0;
  let seq = 0;

  /** An issued invoice and its queued outbox document, as approval would leave them (the outbox suite's fixture). */
  async function queueDocument(): Promise<string> {
    seq += 1;
    const inv = (await writeIssuedFixture(
      `INSERT INTO invoices (organization_id, company_id, invoice_number, date, customer_id, status) VALUES ($1,$2,$3,$4,$5,'sent') RETURNING id`,
      [orgA, coA, `R9-${seq}`, DATE, customerA],
    )).rows[0].id;
    const { rows } = await pool.query(
      `INSERT INTO einvoice_documents (organization_id, company_id, invoice_id, flow, status, invoice_hash, signed_xml, zatca_uuid)
       VALUES ($1,$2,$3,'reporting','pending','SGVsbG8=',$4, gen_random_uuid()) RETURNING id`,
      [orgA, coA, inv, SIGNED_XML],
    );
    return rows[0].id as string;
  }
  const transitions = async (docId: string) => (await pool.query(
    `SELECT user_id, before_state, after_state, (before_state::text || after_state::text) AS raw FROM audit_logs
      WHERE organization_id = $1 AND entity_type = 'einvoice_document' AND action = 'transition' AND entity_id = $2 ORDER BY created_at, id`,
    [orgA, docId],
  )).rows as Array<{ user_id: number | null; before_state: any; after_state: any; raw: string }>;
  const statusPath = (rows: Awaited<ReturnType<typeof transitions>>) => rows.map((r) => `${r.before_state.status}->${r.after_state.status}`);

  const refusals = async () => (await pool.query(
    `SELECT actor_user_id, organization_id, metadata FROM security_audit_logs WHERE action = 'reference.refused' AND actor_user_id = $1 ORDER BY created_at, id`,
    [adminA],
  )).rows as Array<{ actor_user_id: number; organization_id: string; metadata: any }>;
  const waitForRefusals = async (n: number) => {
    await until(`${n} reference refusal(s) recorded`, async () => (await refusals()).length >= n, 5_000).catch(() => undefined);
    return refusals();
  };

  beforeAll(async () => {
    await h.cleanup();
    orgA = await h.mkOrg("a");
    coA = await h.mkCompany(orgA, "R9 Co A", "319191919192103");
    orgB = await h.mkOrg("b");
    await h.mkCompany(orgB, "R9 Co B", "319191919192203");
    adminA = await h.mkUser("adminA", PW, orgA, "admin");
    customerA = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'R9 Customer A') RETURNING id`, [orgA])).rows[0].id;
    customerB = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'R9 Customer B') RETURNING id`, [orgB])).rows[0].id;
    await h.start();
    expect(await h.login("adminA", h.email("adminA"), PW)).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  describe("A — the outbox's transitions", () => {
    it("🔴 claim → fail → claim → accept: one audit row per transition, in order, with no user and never the signed XML", async () => {
      const doc = await queueDocument();
      expect(await einvoiceOutboxRepository.claimDue("r9-worker", 10, orgA)).toHaveLength(1);
      await einvoiceOutboxRepository.markFailed(doc, { errors: [{ code: "R9-TRANSIENT" }], zatcaStatus: null, ambiguous: false, retryInSeconds: 0 });
      expect(await einvoiceOutboxRepository.claimDue("r9-worker", 10, orgA)).toHaveLength(1);
      await einvoiceOutboxRepository.markAccepted(doc, { status: "reported", zatcaStatus: "REPORTED", warnings: null, clearedXml: null });
      const rows = await transitions(doc);
      expect(statusPath(rows)).toEqual(["pending->submitting", "submitting->failed", "failed->submitting", "submitting->reported"]);
      expect(rows.map((r) => r.after_state.attemptCount)).toEqual([1, 1, 2, 2]);
      expect(rows[1]!.after_state.errors).toEqual([{ code: "R9-TRANSIENT" }]);
      expect(rows[0]!.after_state.claimedBy).toBe("r9-worker");
      expect(rows.every((r) => r.user_id === null)).toBe(true);
      expect(rows.some((r) => r.raw.includes("R9-SIGNED-XML"))).toBe(false);
    });

    it("🔴 a reclaim after a dead worker (submitting → pending, AMBIGUOUS) is recorded, ambiguity included", async () => {
      const doc = await queueDocument();
      await einvoiceOutboxRepository.claimDue("r9-dead-worker", 10, orgA);
      // the worker died: its claim is old (a column the trigger does not watch — this update itself records nothing)
      await pool.query(`UPDATE einvoice_documents SET claimed_at = now() - interval '1 hour' WHERE id = $1`, [doc]);
      expect(await einvoiceOutboxRepository.reclaimStale(60, orgA)).toBe(1);
      const rows = await transitions(doc);
      expect(statusPath(rows)).toEqual(["pending->submitting", "submitting->pending"]);
      expect([rows[1]!.before_state.ambiguous, rows[1]!.after_state.ambiguous]).toEqual([false, true]);
    });

    // Added after the proof commit (register §11.107): no writer today changes the ambiguity ALONE, so without this
    // the trigger's second condition is never exercised.
    it("🔴 a change of the ambiguity ALONE (a person's resolution after checking the portal) is recorded", async () => {
      const doc = await queueDocument();
      await pool.query(`UPDATE einvoice_documents SET ambiguous = true WHERE id = $1`, [doc]);
      const rows = await transitions(doc);
      expect(rows.map((r) => [r.before_state.status, r.after_state.status, r.before_state.ambiguous, r.after_state.ambiguous])).toEqual([["pending", "pending", false, true]]);
    });

    it("control — an update that changes neither the status nor the ambiguity records nothing", async () => {
      const doc = await queueDocument();
      await pool.query(`UPDATE einvoice_documents SET updated_at = now(), claimed_at = now() WHERE id = $1`, [doc]);
      expect(await transitions(doc)).toEqual([]);
    });
  });

  describe("B — the cross-tenant reference refusals", () => {
    const invoiceNaming = (customerId: number) => ({
      invoiceNumber: `R9-INV-${++seq}`, date: DATE, dueDate: DATE, customerId,
      items: [{ description: "Work", quantity: 1, unitPrice: 100, vatRate: 15 }],
    });

    it("🔴 another tenant's customer named on an invoice: refused as before, and recorded — the actor, the organisation, the field, the id", async () => {
      const r = await h.api("adminA", "POST", "/invoices", invoiceNaming(customerB));
      expect([r.status, r.body?.code, r.body?.field]).toEqual([422, "reference_not_found", "customerId"]);
      const [row] = (await waitForRefusals(1)).slice(-1);
      expect([row?.actor_user_id, row?.organization_id, row?.metadata?.field, row?.metadata?.requested, row?.metadata?.method, row?.metadata?.path])
        .toEqual([adminA, orgA, "customerId", customerB, "POST", "/api/invoices"]);
      expect(row?.metadata?.companyId).toBe(coA);
    });

    it("🔴 a MISSING customer is recorded the same way — the trail does not tell foreign from missing (G04)", async () => {
      const before = (await refusals()).length;
      const r = await h.api("adminA", "POST", "/invoices", invoiceNaming(2_000_000_001));
      expect([r.status, r.body?.code]).toEqual([422, "reference_not_found"]);
      const rows = await waitForRefusals(before + 1);
      expect(rows.length).toBe(before + 1);
      expect(Object.keys(rows.at(-1)!.metadata).sort()).toEqual(["companyId", "field", "method", "path", "requested"]);
      expect(rows.at(-1)!.metadata.requested).toBe(2_000_000_001);
    });

    it("control — a 400, ANOTHER 422 and a success record nothing", async () => {
      const before = (await refusals()).length;
      expect((await h.api("adminA", "POST", "/invoices", { ...invoiceNaming(customerA), items: "not a list" })).status).toBe(400);
      // added after the proof commit (§11.107): a 422 that is not a reference refusal — H-8's iban_invalid
      const other = await h.api("adminA", "POST", "/vendors", { name: "R9 Bad IBAN", residency: "resident", iban: "SA0380000000608010167518" });
      expect([other.status, other.body?.code]).toEqual([422, "iban_invalid"]);
      expect((await h.api("adminA", "POST", "/invoices", invoiceNaming(customerA))).status).toBe(201);
      await new Promise((res) => setTimeout(res, 300));
      expect((await refusals()).length).toBe(before);
    });

    it("🔴 a refusal TRANSLATED from a tenant-carrying foreign key is recorded too (the error handler's other path)", async () => {
      const before = (await refusals()).length;
      const sent: { status?: number; body?: any } = {};
      const res: any = { headersSent: false, status(s: number) { sent.status = s; return this; }, json(b: unknown) { sent.body = b; return this; } };
      const req: any = {
        method: "POST", originalUrl: "/api/journal-entries?x=1", params: {}, body: { lines: [] },
        tenant: { userId: adminA, organizationId: orgA, companyId: coA, role: "admin" },
        ip: "127.0.0.1", log: { warn: () => undefined, error: () => undefined },
      };
      const fk = Object.assign(new Error("insert or update on table \"journal_entry_lines\" violates foreign key constraint"), {
        code: "23503", constraint: "journal_entry_lines_account_tenant_fk",
        message: "insert or update on table \"journal_entry_lines\" violates foreign key constraint \"journal_entry_lines_account_tenant_fk\"",
      });
      errorHandler(fk, req, res, () => undefined);
      expect([sent.status, sent.body?.code, sent.body?.field]).toEqual([422, "reference_not_found", "lines"]);
      const rows = await waitForRefusals(before + 1);
      expect([rows.length, rows.at(-1)?.metadata?.field, rows.at(-1)?.metadata?.path, rows.at(-1)?.metadata?.requested]).toEqual([before + 1, "lines", "/api/journal-entries", null]);
    });
  });
});
