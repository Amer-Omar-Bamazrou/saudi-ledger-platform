/**
 * 🔴 Phase 18 H-6 — DR-34 (OD-12; F-8), G14: "Refuse the generic reverse for
 * every type that has, or gets, its own correction path. The write-off and
 * invoice/note entries first (legal ties)." DECIDED 2026-10-27 — owner
 * accepted the stated recommendation (register §11.53, the scoped D-4
 * statement, appended before this file).
 *
 *  - an invoice's own entry, a credit note's own entry and its application,
 *    and a bad-debt write-off entry: the generic reverse refuses each by name,
 *    nothing written — a note (VAT IR Art. 54) or the bad-debt path corrects
 *    them;
 *  - control: a manual journal is still reversed generically.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3256";
process.env.SESSION_SECRET ??= "phase18-h6-dr34-owned-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H6Dr34Pw1!";

describeMaybe("Phase 18 H-6 — DR-34: the generic reverse refuses invoice, note and write-off entries", () => {
  const h = g04Harness("p18h6dr34");
  let orgId = "", customerId = 0, seq = 0;
  const ok = (r: { status: number; body: unknown }, status: number) => expect(r.status, JSON.stringify(r.body)).toBe(status);
  const entryOf = async (sourceType: string, sourceId: number) => (await pool.query(
    `SELECT id FROM journal_entries WHERE organization_id = $1 AND source_type = $2 AND source_id = $3 ORDER BY id LIMIT 1`, [orgId, sourceType, sourceId])).rows[0]?.id as number;
  const entries = async () => (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n as number;
  const issue = async (net: number, date: string, extra: Record<string, unknown> = {}) => {
    seq += 1;
    const created = await h.api("admin", "POST", "/invoices", { invoiceNumber: `H6-${seq}`, date, customerId, items: [{ description: "Consulting", quantity: 1, unitPrice: net, vatRate: 15 }], ...extra });
    ok(created, 201);
    ok(await h.api("admin", "POST", `/invoices/${created.body.id}/approve`, {}), 200);
    return created.body.id as number;
  };
  const refusedGenerically = async (entryId: number) => {
    expect(entryId, "the document's entry exists").toBeTruthy();
    const before = await entries();
    const r = await h.api("admin", "POST", `/journal-entries/${entryId}/reverse`, { reason: "reversing a document's entry directly" });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(await entries(), "nothing written").toBe(before);
    expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entryId])).rows[0].status).toBe("posted");
    return r.body.error as string;
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'H6 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'H6 Buyer') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 an INVOICE's own entry is refused by the generic reverse — a credit note corrects it", async () => {
    const inv = await issue(1_000, "2026-09-01");
    expect(await refusedGenerically(await entryOf("invoice", inv))).toMatch(/credit (or debit )?note/i);
  });

  it("🔴 a CREDIT NOTE's own entry is refused too", async () => {
    const inv = await issue(1_000, "2026-09-02");
    const cn = await issue(100, "2026-09-03", { documentType: "credit_note", originalInvoiceId: inv, noteReason: "Partial return" });
    await refusedGenerically(await entryOf("invoice", cn));
  });

  it("🔴 a BAD-DEBT WRITE-OFF entry is refused — the relief rests on the debt being written off in the books", async () => {
    const inv = await issue(1_000, "2025-06-01");
    ok(await h.api("admin", "POST", `/invoices/${inv}/bad-debt-relief`, { claimedOn: "2026-07-01", certificateRef: "CA-H6-1" }), 200);
    await refusedGenerically(await entryOf("invoice_write_off", inv));
  });

  it("control: a MANUAL journal is still reversed generically", async () => {
    const cat = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
    const je = await h.api("admin", "POST", "/journal-entries", { entryNumber: "H6J-1", date: "2026-10-10", description: "Accrual", lines: [
      { accountId: await cat("RENT_UTILITIES"), accountName: "Rent", debitAmount: 300, creditAmount: 0 },
      { accountId: await cat("OTHER_EXPENSES"), accountName: "Other", debitAmount: 0, creditAmount: 300 }] });
    ok(je, 201);
    ok(await h.api("admin", "POST", `/journal-entries/${je.body.id}/approve`, {}), 200);
    const r = await h.api("admin", "POST", `/journal-entries/${je.body.id}/reverse`, { reason: "accrued in error" });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
  });
});
