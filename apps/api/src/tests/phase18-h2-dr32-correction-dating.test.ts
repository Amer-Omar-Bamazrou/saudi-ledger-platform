/**
 * 🔴 Phase 18 H-2 — DR-32 (OD-10; F-4), correction dating: "Both entries on
 * the discovery date by default … never earlier than the original … end the
 * split." DECIDED 2026-10-27 — owner accepted the stated recommendation
 * (register §11.48, the scoped D-4 statement, appended before this file). The
 * original-date option is not built (V-6, legal).
 *
 *  - the one mirror writer refuses a reversal dated before its original — the
 *    generic reverse and the bank-transfer reversal (which forwards the
 *    caller's date) alike;
 *  - a bank-line edit's correction posts BOTH entries on the discovery date:
 *    the original month keeps the line's cash once (it used to re-post at the
 *    original date — the cash counted twice there).
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3254";
process.env.SESSION_SECRET ??= "phase18-h2-dr32-dating-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H2Dr32Pw1!";

describeMaybe("Phase 18 H-2 — DR-32: a correction is never dated before its original, and a bank-line edit posts at discovery", () => {
  const h = g04Harness("p18h2dr32");
  const today = businessToday();
  let orgId = "", bankA = 0, bankB = 0, rentId = 0, otherId = 0, seq = 0;
  const cat = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
  const journal = async (date: string) => {
    const r = await h.api("admin", "POST", "/journal-entries", { entryNumber: `H2J-${++seq}`, date, description: "H2 rent accrual", lines: [
      { accountId: rentId, accountName: "Rent", debitAmount: 500, creditAmount: 0 },
      { accountId: otherId, accountName: "Other", debitAmount: 0, creditAmount: 500 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await h.api("admin", "POST", `/journal-entries/${r.body.id}/approve`, {})).status).toBe(200);
    return r.body.id as number;
  };
  const entries = async () => (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n as number;

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'H2 Co',1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    bankA = (await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" })).body.id;
    bankB = (await h.api("admin", "POST", "/bank-accounts", { name: "Payroll", bankName: "ANB", currency: "SAR" })).body.id;
    rentId = await cat("RENT_UTILITIES");
    otherId = await cat("OTHER_EXPENSES");
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 the generic reverse refuses a date BEFORE the original — nothing written", async () => {
    const id = await journal("2026-10-10");
    const before = await entries();
    const r = await h.api("admin", "POST", `/journal-entries/${id}/reverse`, { reason: "posted to the wrong account", date: "2026-10-05" });
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([422, "reversal_before_original"]);
    expect(await entries()).toBe(before);
  });

  it("control: on the original's own date, or later, the reversal posts", async () => {
    const id = await journal("2026-10-10");
    const same = await h.api("admin", "POST", `/journal-entries/${id}/reverse`, { reason: "same day", date: "2026-10-10" });
    expect([200, 201], JSON.stringify(same.body)).toContain(same.status);
  });

  it("🔴 the DEFAULT is the discovery date — and for an original dated after today, the original's own date (never refused for want of a date)", async () => {
    const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 5);
    const later = d.toISOString().slice(0, 10);
    const id = await journal(later);
    const r = await h.api("admin", "POST", `/journal-entries/${id}/reverse`, { reason: "accrued twice" });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    expect(r.body.reversal.date).toBe(later);
    const now = await journal(today);
    const r2 = await h.api("admin", "POST", `/journal-entries/${now}/reverse`, { reason: "accrued twice" });
    expect(r2.body.reversal?.date, JSON.stringify(r2.body)).toBe(today);
  });

  it("🔴 a bank transfer's reversal, which forwards the caller's date, is refused before the transfer too", async () => {
    const t = await h.api("admin", "POST", "/bank-transfers", { fromBankAccountId: bankA, toBankAccountId: bankB, amount: 700, transferDate: "2026-10-12" });
    expect([200, 201], JSON.stringify(t.body)).toContain(t.status);
    const before = await entries();
    const r = await h.api("admin", "POST", `/bank-transfers/${t.body.id}/reverse`, { reason: "entered twice", date: "2026-10-01" });
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([422, "reversal_before_original"]);
    expect(await entries()).toBe(before);
  });

  it("🔴 a bank-line edit posts BOTH its reversal and its new entry on the discovery date — the original month keeps the line's cash once", async () => {
    const tx = await h.api("admin", "POST", "/transactions", { date: "2026-09-15", description: "OFFICE RENT SEPT", amount: 3_000, currency: "SAR", type: "debit", bankAccountId: bankA });
    expect(tx.status, JSON.stringify(tx.body)).toBe(201);
    const leaf = (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [bankA])).rows[0].id as number;
    const cashIn = async (from: string, to: string) => Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE l.account_id = $1 AND e.date >= $2 AND e.date <= $3 AND e.status IN ('posted','reversed')`, [leaf, from, to])).rows[0].v);
    expect(await cashIn("2026-09-01", "2026-09-30"), "the line's cash, once, in September").toBe(-3_000);
    const u = await h.api("admin", "PATCH", `/transactions/${tx.body.id}`, { categoryId: rentId });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(await cashIn("2026-09-01", "2026-09-30"), "still once in September — never re-posted there").toBe(-3_000);
    expect(await cashIn(today, today), "the correction's month moves the category only: no net cash on the discovery date").toBe(0);
    const dated = (await pool.query(`SELECT e.date::text AS d FROM journal_entries e WHERE e.reference = $1 ORDER BY e.id`, [`TXN-${tx.body.id}`])).rows.map((r) => r.d);
    expect(dated, "the original on its date; the reversal and the new entry on the discovery date").toEqual(["2026-09-15", today, today]);
  });
});
