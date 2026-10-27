/**
 * 🔴 The PR C correction route for an invoice ZATCA rejected (Phase 18; owner
 * decision 2 of 2026-10-27, constraints (a)–(e); final-run memo §2 E).
 *  - An approver records the rejection, with ZATCA's response attached.
 *    Nothing posts, and nothing on the invoice or its entry changes.
 *  - The rejected invoice cannot be paid.
 *  - (a) The correction is a NEW invoice linked FROM it: its own number, ICV,
 *    hash and UUID. The frozen entry and the frozen invoice are never modified.
 *  - (b)(c)(d) Once the correction is issued, the books hold the sale ONCE, at
 *    the corrected figures, in the tax point's month. The VAT return and AR
 *    count the correction only; the rejected document shows as rejected.
 *  - (e) A correction that is itself rejected repeats the route.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3242";
process.env.SESSION_SECRET ??= "phase18-rejected-correction-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18RejectedCorrectionPw1!";
const ZATCA_400 = '{"validationResults":{"status":"ERROR","errorMessages":[{"code":"BR-KSA-37","message":"The buyer VAT number is invalid"}]}}';

type PgErr = { code?: string; constraint?: string; message: string };

describeMaybe("The correction route for a rejected invoice — the sale recorded once, the frozen rows untouched", () => {
  const h = g04Harness("p18rej");
  let orgId = "";
  let companyId = "";
  let customerId = 0;

  const issue = async (n: string, date: string, unitPrice: number): Promise<number> => {
    const created = await h.api("admin", "POST", "/invoices", { invoiceNumber: n, date, customerId, items: [{ description: "Consulting", quantity: 1, unitPrice, vatRate: 15 }] });
    expect(created.status, `create ${n}: ${JSON.stringify(created.body)}`).toBe(201);
    const approved = await h.api("admin", "POST", `/invoices/${created.body.id}/approve`, {});
    expect(approved.status, `approve ${n}: ${JSON.stringify(approved.body)}`).toBe(200);
    return created.body.id as number;
  };
  /** The submission ZATCA answered with a 400 (the worker leaves it failed / needs review; register §11.8). */
  const submissionFailed = (invoiceId: number) =>
    pool.query(`INSERT INTO einvoice_documents (organization_id, company_id, invoice_id, flow, status) VALUES ($1, $2, $3, 'clearance', 'failed')`, [orgId, companyId, invoiceId]);
  const reject = (id: number, body: Record<string, unknown> = { zatcaResponse: ZATCA_400, reason: "BR-KSA-37: the buyer VAT number is invalid" }, who = "admin") =>
    h.api(who, "POST", `/invoices/${id}/rejection`, body);
  const correct = async (id: number, unitPrice: number) => {
    const draft = await h.api("admin", "POST", `/invoices/${id}/correction`, {});
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const items = [{ description: "Consulting", quantity: 1, unitPrice, vatRate: 15 }];
    const edited = await h.api("admin", "PATCH", `/invoices/${draft.body.id}`, { items });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const approved = await h.api("admin", "POST", `/invoices/${draft.body.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return draft.body.id as number;
  };
  /** The month's sale in the GL: revenue, output VAT, receivable (posted + reversed entries, JE_IN_BOOKS). */
  const gl = async (from: string, to: string) => {
    const { rows } = await pool.query(
      `SELECT c.system_code AS code, round(sum(l.credit_amount - l.debit_amount), 2)::float AS net
         FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND e.status IN ('posted', 'reversed') AND e.date BETWEEN $2 AND $3
          AND c.system_code IN ('SALES', 'VAT_OUTPUT', 'AR')
        GROUP BY c.system_code`, [orgId, from, to]);
    const by = Object.fromEntries(rows.map((r) => [r.code, r.net]));
    return { sales: by.SALES ?? 0, vat: by.VAT_OUTPUT ?? 0, ar: -(by.AR ?? 0) };
  };
  const frozen = async (id: number) =>
    (await pool.query(
      `SELECT md5(i::text) AS invoice, (SELECT md5(string_agg(e::text || l::text, '|' ORDER BY e.id, l.id)) FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
                                       WHERE e.source_type = 'invoice' AND e.source_id = i.id) AS entry
         FROM invoices i WHERE i.id = $1`, [id])).rows[0];
  const vatReturn = async (month: string) => {
    const r = await h.api("admin", "GET", `/reports/vat-return?period_from=${month}&period_to=${month}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { outputVat: r.body.salesSection.box8_totalOutputVat as number, invoices: r.body.invoiceCount as number };
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "Rejected Correction Co", "318181818181999");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("keeper", PW, orgId, "bookkeeper");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, tax_number) VALUES ($1, 'Rejected Correction Buyer', '300000000000003') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    expect(await h.login("keeper", h.email("keeper"), PW), "login keeper").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 an approver records the rejection with ZATCA's response; nothing posts, and the invoice and its entry are untouched", async () => {
    const id = await issue("REJ-001", "2026-03-10", 1000);
    await submissionFailed(id);
    const before = await frozen(id);
    const entriesBefore = Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);
    const r = await reject(id);
    const entriesAfter = Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);
    const shown = await h.api("admin", "GET", `/invoices/${id}`);
    expect([r.status, entriesAfter - entriesBefore, await frozen(id), shown.body.rejection?.zatcaResponse], JSON.stringify(r.body))
      .toEqual([201, 0, before, ZATCA_400]);
  });

  it("🔴 the rejection is refused without ZATCA's response or a reason, to a bookkeeper, without a submission, and twice", async () => {
    const id = await issue("REJ-002", "2026-03-11", 100);
    const noSubmission = await reject(id);
    await submissionFailed(id);
    const noResponse = await reject(id, { reason: "x" });
    const noReason = await reject(id, { zatcaResponse: ZATCA_400 });
    const keeper = await reject(id, undefined, "keeper");
    const first = await reject(id);
    const second = await reject(id);
    expect([noSubmission.status, noSubmission.body.code, noResponse.status, noReason.status, keeper.status, first.status, second.status, second.body.code])
      .toEqual([409, "invoice_not_submitted", 422, 422, 403, 201, 409, "invoice_already_rejected"]);
  });

  it("🔴 a rejected invoice cannot be paid; a rejection is refused while a payment is applied", async () => {
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "REJ Main", bankName: "REJ Bank", isDefault: true });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    const paidFirst = await issue("REJ-003", "2026-03-12", 100);
    await submissionFailed(paidFirst);
    const paid = await h.api("admin", "POST", `/invoices/${paidFirst}/pay`, { amount: 50, paidAt: "2026-03-13", bankAccountId: bank.body.id });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const withPayment = await reject(paidFirst);
    const rejectedFirst = await issue("REJ-004", "2026-03-12", 100);
    await submissionFailed(rejectedFirst);
    expect((await reject(rejectedFirst)).status).toBe(201);
    const pay = await h.api("admin", "POST", `/invoices/${rejectedFirst}/pay`, { amount: 50, paidAt: "2026-03-13", bankAccountId: bank.body.id });
    expect([withPayment.status, withPayment.body.code, pay.status, pay.body.code]).toEqual([409, "rejected_invoice_has_payments", 409, "invoice_rejected"]);
  });

  it("🔴 (a)(b)(c)(d) the correction is a NEW invoice linked from itself; the books, the VAT return and AR hold the sale ONCE, at the corrected figures, in the tax point's month", async () => {
    const id = await issue("REJ-010", "2026-05-10", 1000);
    await submissionFailed(id);
    expect((await reject(id)).status).toBe(201);
    const before = await frozen(id);
    const fixed = await correct(id, 1200);
    const [orig, corr] = (await pool.query(`SELECT id, invoice_number, icv, invoice_hash, zatca_uuid, date, corrects_invoice_id FROM invoices WHERE id IN ($1, $2) ORDER BY id`, [id, fixed])).rows;
    const ar = await h.api("admin", "GET", "/reports/ar-aging");
    const arIds = (ar.body.items as Array<{ invoiceId?: number; id?: number }>).map((x) => x.invoiceId ?? x.id);
    expect({
      linkFromNew: corr.corrects_invoice_id, ownIdentity: [corr.invoice_number !== orig.invoice_number, corr.icv !== orig.icv, corr.invoice_hash !== orig.invoice_hash, corr.zatca_uuid !== orig.zatca_uuid],
      sameTaxPoint: corr.date, frozenUntouched: (await frozen(id)), gl: await gl("2026-05-01", "2026-05-31"), vat: await vatReturn("2026-05"),
      ar: [arIds.includes(fixed), arIds.includes(id)],
    }).toEqual({
      linkFromNew: id, ownIdentity: [true, true, true, true], sameTaxPoint: "2026-05-10", frozenUntouched: before,
      gl: { sales: 1200, vat: 180, ar: 1380 }, vat: { outputVat: 180, invoices: 1 }, ar: [true, false],
    });
  });

  it("🔴 (e) a correction that is itself rejected repeats the route — still once", async () => {
    const id = await issue("REJ-020", "2026-06-15", 500);
    await submissionFailed(id);
    expect((await reject(id)).status).toBe(201);
    const first = await correct(id, 600);
    await submissionFailed(first);
    expect((await reject(first)).status).toBe(201);
    const second = await correct(first, 700);
    const link = (await pool.query(`SELECT corrects_invoice_id FROM invoices WHERE id = $1`, [second])).rows[0].corrects_invoice_id;
    expect([link, await gl("2026-06-01", "2026-06-30"), await vatReturn("2026-06")]).toEqual([first, { sales: 700, vat: 105, ar: 805 }, { outputVat: 105, invoices: 1 }]);
  });

  it("🔴 the database: one issued correction per rejected invoice; a correction must name a REJECTED invoice of its customer and date; the link never changes once issued", async () => {
    const id = await issue("REJ-030", "2026-07-01", 100);
    const notRejected = await h.api("admin", "POST", `/invoices/${id}/correction`, {});
    await submissionFailed(id);
    expect((await reject(id)).status).toBe(201);
    const fixed = await correct(id, 110);
    const secondCorrection = await h.api("admin", "POST", `/invoices/${id}/correction`, {});
    const relink = await (async (): Promise<PgErr | null> => {
      const c = await pool.connect();
      try { await c.query(`UPDATE invoices SET corrects_invoice_id = NULL WHERE id = $1`, [fixed]); return null; } catch (e) { return e as PgErr; } finally { c.release(); }
    })();
    expect([notRejected.status, notRejected.body.code, secondCorrection.status, secondCorrection.body.code, relink?.constraint])
      .toEqual([409, "invoice_not_rejected", 409, "invoice_already_corrected", "invoice_correction_link_fixed"]);
  });
});
