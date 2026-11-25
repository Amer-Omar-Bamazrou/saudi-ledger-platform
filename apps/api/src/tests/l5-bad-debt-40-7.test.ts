/**
 * 🔴 L5 (owner, 2026-11-25; Arabic text verified) — BAD-DEBT RELIEF: the checks the regulation itself states.
 *
 *  - Art. 40(7)(a): the invoice's output VAT was declared in a FILED return — its tax period (the invoice's month) lies
 *    inside a VAT return recorded filed (an original filing, monthly or quarterly). Otherwise refused, naming the
 *    period, in English and Arabic; nothing posts.
 *  - Art. 40(7)(b): the customer is not a related party — a STATED declaration (who and when kept on the invoice) until
 *    the platform records related parties. Refused without it.
 *  - Already enforced, unchanged: 40(7)(c) twelve months, (d) the certificate, (e) above SAR 100,000 the legal
 *    procedures (ap-period-correction.test.ts); 40(8) holds by construction (no cash-basis setting exists).
 * The filing is recorded through the product's own path (POST /tax/vat-return-filings). DB-backed; skips on the placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { emptyInvoiceLine, invoiceLinesBody } from "@workspace/shared";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "l5-bad-debt-password-2026";
const h = g04Harness("l5bd");

describeDb("L5 — Art. 40(7)(a) and (b) at the write-off", () => {
  let orgId = "";
  let userId = 0;
  let customerId = 0;

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "L5 Bad Debt Co", "319696969696963");
    userId = await h.mkUser("admin", PW, orgId, "admin");
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    const c = await h.api("admin", "POST", "/customers", { name: "Unpaid walk-in" });
    expect(c.status, c.text).toBe(201);
    customerId = c.body.id;
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  async function issued(date: string): Promise<{ id: number; number: string }> {
    const d = await h.api("admin", "POST", "/invoices", { date, dueDate: date, customerId, items: invoiceLinesBody([{ ...emptyInvoiceLine(), description: "Services", quantity: "1", unitPrice: "1000" }]) });
    expect(d.status, d.text).toBe(201);
    expect((await h.api("admin", "POST", `/invoices/${d.body.id}/submit`)).status).toBe(200);
    const a = await h.api("admin", "POST", `/invoices/${d.body.id}/approve`);
    expect(a.status, a.text).toBe(200);
    return { id: d.body.id, number: d.body.invoiceNumber };
  }
  const state = async (id: number) => (await pool.query(`SELECT written_off_amount, bad_debt_relief_unrelated_declared_by, bad_debt_relief_unrelated_declared_at FROM invoices WHERE id = $1`, [id])).rows[0];
  const entries = async (id: number) => Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE source_type = 'invoice_write_off' AND source_id = $1`, [id])).rows[0].n);
  const relief = (id: number, extra: Record<string, unknown> = {}) =>
    h.api("admin", "POST", `/invoices/${id}/bad-debt-relief`, { claimedOn: "2026-06-01", certificateRef: "CA-2026-L5", ...extra });

  it("🔴 40(7)(a): an invoice whose month is in no filed return is refused, naming the period, in both languages — nothing posts", async () => {
    const inv = await issued("2025-01-10");
    const r = await relief(inv.id, { notRelatedPartyDeclared: true });
    expect([r.status, r.body.code, r.body.period]).toEqual([422, "bad_debt_output_vat_not_filed", "2025-01"]);
    expect(r.body.error).toContain("2025-01");
    expect(r.body.errorAr).toContain("2025-01");
    expect(await entries(inv.id)).toBe(0);
    expect(Number((await state(inv.id)).written_off_amount ?? 0)).toBe(0);
    // movement: the month filed through the product's own path — the same request now passes (a)
    const f = await h.api("admin", "POST", "/tax/vat-return-filings", { periodFrom: "2025-01", periodTo: "2025-01", filedOn: "2025-02-20", zatcaReference: "ZATCA-L5-2501" });
    expect(f.status, f.text).toBe(201);
    const ok = await relief(inv.id, { notRelatedPartyDeclared: true });
    expect(ok.status, ok.text).toBe(200);
    expect(await entries(inv.id)).toBe(1);
  });

  it("🔴 40(7)(b): without the stated declaration that the customer is not a related party, refused — with it, the declaration's who and when are kept", async () => {
    const f = await h.api("admin", "POST", "/tax/vat-return-filings", { periodFrom: "2025-04", periodTo: "2025-06", filedOn: "2025-07-25", zatcaReference: "ZATCA-L5-25Q2" });
    expect(f.status, f.text).toBe(201);
    const inv = await issued("2025-05-15"); // inside a QUARTERLY filing
    for (const declared of [undefined, false]) {
      const r = await relief(inv.id, declared === undefined ? {} : { notRelatedPartyDeclared: declared });
      expect([String(declared), r.status, r.body.code, r.body.field]).toEqual([String(declared), 422, "bad_debt_related_party_declaration_required", "notRelatedPartyDeclared"]);
      expect(typeof r.body.errorAr).toBe("string");
    }
    expect(await entries(inv.id)).toBe(0);
    const ok = await relief(inv.id, { notRelatedPartyDeclared: true });
    expect(ok.status, ok.text).toBe(200);
    const s = await state(inv.id);
    expect(s.bad_debt_relief_unrelated_declared_by).toBe(userId);
    expect(s.bad_debt_relief_unrelated_declared_at).not.toBeNull();
    expect(typeof ok.body.badDebtRelief?.notRelatedPartyDeclaredAt).toBe("string");
  });
});
