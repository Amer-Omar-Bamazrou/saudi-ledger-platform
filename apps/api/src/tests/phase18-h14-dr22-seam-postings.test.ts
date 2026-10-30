/**
 * 🔴 Phase 18 H-14 — DR-22 (D-13), its third batch (contract §8.6 items 1, 2
 * and 5): every journal entry the posting seam posts is recorded in the audit
 * trail — a document's entry and a depreciation alike, since both go through
 * `postJournalEntry` — and the generic reversal's audit image carries its
 * reason. DECIDED 2026-10-27 — owner accepted the stated recommendation
 * (register §11.65, the scoped D-4 statement, appended before this file).
 *
 * Acts over HTTP, and once on the seam directly with NO request context.
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3264";
process.env.SESSION_SECRET ??= "phase18-h14-seam-postings-000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { postJournalEntry } from "../services/accounting/glPosting";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H14SeamPw1!";

describeMaybe("Phase 18 H-14 — DR-22: every entry the posting seam posts is recorded; a reversal's image carries its reason", () => {
  const h = g04Harness("p18h14seam");
  const today = businessToday();
  let orgId = "", companyId = "", adminId = 0, expense = 0, income = 0, seq = 0;
  const postRows = async (entryId: number) => (await pool.query(
    `SELECT user_id, ip_address, after_state FROM audit_logs
      WHERE organization_id = $1 AND entity_type = 'journal_entry' AND action = 'post' AND entity_id = $2`, [orgId, String(entryId)])).rows;

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "H14 Co", "399999999999953");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    const acct = async (code: string) =>
      (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
    expense = await acct("RENT_UTILITIES");
    income = await acct("OTHER_INCOME");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a document's entry is recorded: an invoice's approval posts through the seam, and that posting has its own row", async () => {
    const customerId = (await h.api("admin", "POST", "/customers", { name: "H14 Customer" })).body.id;
    const inv = await h.api("admin", "POST", "/invoices", { date: today, customerId, items: [{ description: "Service", quantity: 1, unitPrice: 100, vatRate: 15 }] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await h.api("admin", "POST", `/invoices/${inv.body.id}/approve`, {})).status).toBe(200);
    const je = (await pool.query(`SELECT id, entry_number FROM journal_entries WHERE organization_id = $1 AND source_type = 'invoice' AND source_id = $2`, [orgId, inv.body.id])).rows[0];
    expect(je, "the approval posted an entry").toBeTruthy();
    const rows = await postRows(je.id);
    expect(rows.map((r) => [r.user_id, r.after_state.sourceType, Number(r.after_state.sourceId), r.after_state.entryNumber, r.after_state.totalDebit, r.after_state.lineCount > 0]))
      .toEqual([[adminId, "invoice", inv.body.id, je.entry_number, 115, true]]);
    expect(rows[0].ip_address, "the request's IP").toBeTruthy();
  });

  it("🔴 the seam needs no request context: an entry posted with none is still recorded — no user, no IP", async () => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    let entryId = 0;
    try {
      const je = await conn.run(() => postJournalEntry({
        entryNumber: `H14-SEAM-${++seq}`, date: today, description: "H14 posted with no request context",
        lines: [
          { accountId: expense, accountName: "debit", debitAmount: 40, creditAmount: 0 },
          { accountId: income, accountName: "credit", debitAmount: 0, creditAmount: 40 },
        ],
      }));
      entryId = je.id;
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
    expect((await postRows(entryId)).map((r) => [r.user_id, r.ip_address, r.after_state.totalDebit, r.after_state.lineCount])).toEqual([[null, null, 40, 2]]);
  });

  it("🔴 a manual journal's reversal records its REASON in the reversal's audit image", async () => {
    const created = await h.api("admin", "POST", "/journal-entries", {
      entryNumber: `H14-JE-${++seq}`, date: today, description: "H14 manual",
      lines: [
        { accountId: expense, accountName: "debit", debitAmount: 60, creditAmount: 0 },
        { accountId: income, accountName: "credit", debitAmount: 0, creditAmount: 60 },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await h.api("admin", "POST", `/journal-entries/${created.body.id}/approve`, {})).status).toBe(200);
    const rev = await h.api("admin", "POST", `/journal-entries/${created.body.id}/reverse`, { reason: "H14 posted to the wrong account", date: today });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const reversalId = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND reversal_of = $2`, [orgId, created.body.id])).rows[0].id as number;
    const image = (await pool.query(
      `SELECT after_state->>'reversalReason' AS reason FROM audit_logs WHERE organization_id = $1 AND entity_type = 'journal_entry' AND action = 'create' AND entity_id = $2`,
      [orgId, String(reversalId)])).rows;
    expect(image.map((r) => r.reason)).toEqual(["H14 posted to the wrong account"]);
  });
});
