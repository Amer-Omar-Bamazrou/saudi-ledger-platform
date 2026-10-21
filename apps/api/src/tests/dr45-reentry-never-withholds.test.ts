/**
 * 🔴 DR-45 (II) — REGRESSION: a correction's re-entry never turns a payment
 * made with nothing withheld (`pending` or `not_subject`) into a withheld one.
 *
 * Tax on such a payment now is open question W-16 (recovered from the
 * supplier, or borne by the payer), so a re-entry never records it — exactly
 * as a reclassification never does. Enforced twice: both pay paths refuse
 * BEFORE anything is written (`refuseLateWithholdingOnReentry`, the
 * reclassification's own code `wht_late_withholding_open`), and the database
 * rule `wht_late_withholding` (0123) refuses the insert for any writer that
 * skips that — the mutation run neutralises the service check to prove it.
 *
 * Each re-entry here KEEPS the cash (its amount is grossed up so that amount −
 * tax = the cash that left), so safeguard (I) lets it through and (II) is what
 * refuses — the Batch 4B proof's case D is refused by (I) instead, because its
 * re-entry changes the cash.
 *
 * Also: the migration's refusing pre-check, PROBED on a planted violation (a
 * rolled-back transaction in replica mode), so it is proven to see a present
 * case — on CI's empty database it would otherwise pass vacuously.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3204";
process.env.SESSION_SECRET ??= "dr45-reentry-never-withholds-regression-1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "DR45IIRegressionPw123!";
const MIGRATION = path.resolve(__dirname, "../../../../packages/db/migrations/0123_dr45_reentry_late_withholding.sql");

describeMaybe("DR-45 (II) — a correction's re-entry never withholds on a payment made with nothing withheld", () => {
  const h = g04Harness("dr45iireg");
  let orgId = "";
  let vendorId = 0;
  let bankId = 0;
  let seq = 0;

  const counts = async () => (await pool.query(
    `SELECT (SELECT count(*)::int FROM journal_entries WHERE organization_id = $1) AS je,
            (SELECT count(*)::int FROM wht_corrections WHERE organization_id = $1) AS corr,
            (SELECT count(*)::int FROM wht_withholdings WHERE organization_id = $1) AS w,
            (SELECT count(*)::int FROM bill_payments WHERE organization_id = $1) AS bp,
            (SELECT count(*)::int FROM supplier_payments WHERE organization_id = $1) AS sp`, [orgId],
  )).rows[0];
  const correct = (withholdingId: number, body: Record<string, unknown>) => h.api("admin", "POST", `/tax/wht/withholdings/${withholdingId}/reverse`, body);

  /** A supplier payment the platform recorded with nothing withheld: `unknown` (pending). */
  async function pendingPayment(amount: number) {
    const sp = await h.api("admin", "POST", "/supplier-payments", { vendorId, bankAccountId: bankId, amount, paidAt: "2026-06-12", classification: "unknown" });
    expect(sp.status, JSON.stringify(sp.body)).toBe(201);
    const w = (await pool.query(`SELECT id, status FROM wht_withholdings WHERE supplier_payment_id = $1`, [sp.body.id])).rows[0];
    expect(w.status).toBe("pending");
    return w.id as number;
  }
  /** A bill payment declared not subject (goods): nothing withheld. */
  async function goodsBillPayment(billTotal: number, paid: number) {
    seq += 1;
    const no = `DR45II-B${seq}`;
    const created = await h.api("bookkeeper", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `${no}-SUP`, billNumber: no, date: "2026-06-01", dueDate: "2026-06-30", vendorId,
      items: [{ description: "Spare parts", quantity: 1, unitPrice: billTotal, vatRate: 0 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await h.api("admin", "POST", `/bills/${created.body.id}/approve`, {})).status).toBe(200);
    const p = await h.api("admin", "POST", `/bills/${created.body.id}/pay`, { amount: paid, paidAt: "2026-06-10", bankAccountId: bankId, whtNotSubjectReason: "goods" });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const w = (await pool.query(`SELECT id, status FROM wht_withholdings WHERE bill_id = $1 AND correction_id IS NULL`, [created.body.id])).rows[0];
    expect(w.status).toBe("not_subject");
    return w.id as number;
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "DR45 II Co", "318181818181886");
    vendorId = (await pool.query(
      `INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type, country, foreign_tax_id)
       VALUES ($1,'DR45 II London Tech','non_resident','technical_consulting','GB','GB-DR45II-1') RETURNING id`, [orgId],
    )).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const b = await h.api("admin", "POST", "/bank-accounts", { name: "DR45 II Ops", bankName: "Riyad", currency: "SAR" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    bankId = b.body.id;
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a PENDING supplier payment re-entered as a withheld advance — cash kept (10,526.32 − 526.32 = 10,000) — is refused (409 wht_late_withholding_open); nothing written", async () => {
    const id = await pendingPayment(10_000);
    const before = await counts();
    const r = await correct(id, { reason: "identified: a consulting advance", date: "2026-06-20", reentry: { amount: 10_526.32, paidAt: "2026-06-12", classification: "advance", whtPaymentType: "technical_consulting" } });
    // eslint-disable-next-line no-console
    console.warn("[DR45 II] pending → withheld", JSON.stringify({ status: r.status, code: r.body?.code, error: String(r.body?.error ?? "").slice(0, 140) }));
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([409, "wht_late_withholding_open"]);
    expect(await counts(), "refused: nothing written").toEqual(before);
  }, 60_000);

  it("🔴 a NOT-SUBJECT (goods) bill payment re-entered as withheld consulting — cash kept — is refused the same way; nothing written", async () => {
    const id = await goodsBillPayment(20_000, 10_000);
    const before = await counts();
    const r = await correct(id, { reason: "it was a consulting fee, not parts", date: "2026-06-20", reentry: { amount: 10_526.32, paidAt: "2026-06-10", whtPaymentType: "technical_consulting" } });
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([409, "wht_late_withholding_open"]);
    expect(await counts(), "refused: nothing written").toEqual(before);
  }, 60_000);

  it("CONTROL: a pending payment's correction that withholds nothing completes (the probe is not vacuous)", async () => {
    const id = await pendingPayment(5_000);
    const r = await correct(id, { reason: "still unidentified; reference corrected", date: "2026-06-20", reentry: { amount: 5_000, paidAt: "2026-06-12", classification: "unknown" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const re = (await pool.query(`SELECT w.status FROM wht_corrections c JOIN wht_withholdings w ON w.correction_id = c.id WHERE c.withholding_id = $1`, [id])).rows[0];
    expect(re?.status).toBe("pending");
  }, 60_000);

  it("🔴 0123's refusing pre-check SEES a planted violation: the counting function, and the migration's own pre-check block, refuse (rolled back)", async () => {
    // a correction whose re-entry is pending, then — in replica mode, inside a transaction that is rolled back — marked withheld
    const id = await pendingPayment(3_000);
    const ok = await correct(id, { reason: "a correction to plant a violation on", date: "2026-06-20", reentry: { amount: 3_000, paidAt: "2026-06-12", classification: "unknown" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const sql = fs.readFileSync(MIGRATION, "utf8");
    const precheck = sql.slice(sql.indexOf("DO $$"), sql.indexOf("END $$;", sql.indexOf("DO $$")) + "END $$;".length);
    expect(precheck, "the pre-check block was found in the migration").toMatch(/^DO \$\$[\s\S]*wht_reentry_late_withholding_count\(\)[\s\S]*END \$\$;$/);
    const c = await pool.connect();
    let n0 = 0;
    try {
      await c.query("BEGIN");
      // the function counts every organisation's rows: compare with what is there before the plant (0 on CI's fresh database)
      n0 = Number((await c.query(`SELECT wht_reentry_late_withholding_count() AS n`)).rows[0].n);
      await c.query("SET LOCAL session_replication_role = replica");
      const planted = await c.query(
        // a WELL-FORMED withheld row (every CHECK on wht_withholdings holds — they bind in replica mode too); only the
        // new rule, which replica mode skips, would refuse it
        `UPDATE wht_withholdings w SET status = 'withheld', payment_type = r.payment_type, rate_id = r.id, rate = r.rate, statutory_rate = r.rate,
                wht_amount = round(w.base_amount * r.rate, 2)
           FROM wht_corrections x, (SELECT id, payment_type, rate FROM wht_rates WHERE payment_type = 'technical_consulting' ORDER BY effective_from DESC LIMIT 1) r
          WHERE x.withholding_id = $1 AND w.correction_id = x.id RETURNING w.id`, [id]);
      expect(planted.rowCount).toBe(1);
      await c.query("SET LOCAL session_replication_role = origin");
      expect(Number((await c.query(`SELECT wht_reentry_late_withholding_count() AS n`)).rows[0].n), "the planted violation is counted").toBe(n0 + 1);
      await c.query("SAVEPOINT pre");
      const refused = await c.query(precheck).then(() => null, (e: { code?: string; message?: string }) => e);
      expect(refused?.code, "the migration's pre-check refuses").toBe("23514");
      expect(refused?.message).toMatch(/^0123 refuses to apply: [0-9]+ WHT correction re-entr(y|ies) already record/);
      await c.query("ROLLBACK TO SAVEPOINT pre");
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    expect(Number((await pool.query(`SELECT wht_reentry_late_withholding_count() AS n`)).rows[0].n), "rolled back: nothing planted remains").toBe(n0);
  }, 60_000);
});
