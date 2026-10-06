/**
 * G30 (pre-Phase-18 hardening, owner decision D-0, 2026-10-07) — the bank
 * details printed on an ISSUED invoice are the ones in force when it was
 * issued, and re-rendering it later reproduces them.
 *
 * 🔴 THE DEFECT. The invoice document model read the company's CURRENT
 * default bank account at render time (`bankAccountsRepository.list()` →
 * `isDefault`). An issued invoice is re-rendered on demand, so changing a
 * bank account's IBAN — a WRITE-role act, a bookkeeper's — silently changed
 * the payment instructions on every invoice already issued, with nothing on
 * the document to show it. `bank-account-default.test.ts` pinned that as
 * intended ("follows a change").
 *
 * THE RULE THESE TESTS HOLD: the bank details are captured at ISSUE, inside
 * the issuing transaction, from the company's default bank account, and
 * stored on the invoice with the bank account they came from. From then on
 * the issued document prints that capture and nothing else; the company's
 * bank accounts remain the source for documents not yet issued. The capture
 * is frozen at the database. Notes and advance tax invoices still print no
 * bank details (the money already moved — unchanged rule).
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3111";
process.env.SESSION_SECRET ??= "g30-issued-bank-details-test-session-secret-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, beginTenantConnection, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { __resetRateLimitsForTests } from "../routes/auth";
import { auditContext } from "../lib/auditContext";
import { buildInvoiceDocModel } from "../services/invoiceDocument/invoiceDocument.service";
import { renderInvoiceHtml } from "../services/invoiceDocument/renderInvoiceHtml";
import { invoicesService } from "../services/invoices.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { bankAccountsRepository } from "../repositories/bankAccounts.repository";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[g30-issued-invoice-bank-details] no real DATABASE_URL — skipping.");
}

const PW = "G30BankPw123!";
const P = "g30bd";
const email = (k: string) => `${P}-${k}@test.local`;
const IBAN_1 = "SA0380000000608010167519";
const IBAN_2 = "SA4420000001234567891234";
const IBAN_3 = "SA1010000009876543210987";

describeMaybe("G30 — an issued invoice keeps the bank details in force when it was issued", () => {
  let server: http.Server;
  let base = "";
  let orgId = "";
  let companyId = "";
  let otherOrgId = "";
  let otherCompanyId = "";
  let customerId = 0;
  let mainBankId = 0;
  let secondBankId = 0;
  let firstInvoiceId = 0;
  const ids: Record<string, number> = {};

  const ORG_FILTER = `(SELECT id FROM organizations WHERE slug LIKE '${P}-%')`;
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const t of ["journal_entry_lines", "journal_entries", "invoice_items", "einvoice_documents", "invoices", "customers", "bank_accounts", "audit_logs", "organization_memberships", "categories", "companies"]) {
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

  const jar: Record<string, string> = {};
  async function api(who: string, method: string, path: string, body?: unknown) {
    const cookie = jar[who] ?? "";
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = ((res.headers as any).getSetCookie?.() ?? []).find((c: string) => c.startsWith("ksa_ledger_sid="));
    if (sid) jar[who] = sid.split(";")[0];
    let json: any;
    try { json = await res.json(); } catch { json = undefined; }
    return { status: res.status, body: json };
  }

  const tenant = (org: string, company: string) => async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: company, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: ids.admin, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };
  const inTenant = <T,>(fn: () => Promise<T>) => tenant(orgId, companyId)(fn);
  const model = (id: number, lang: "ar" | "en" = "ar") => inTenant(() => buildInvoiceDocModel(id, lang));

  async function issue(n: string, extra: Record<string, unknown> = {}): Promise<number> {
    const created = await api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: n,
      date: "2026-10-01",
      customerId,
      items: [{ description: "Service", quantity: 1, unitPrice: 1000, vatRate: 15 }],
      ...extra,
    });
    expect(created.status, `create ${n}: ${JSON.stringify(created.body)}`).toBe(201);
    const approved = await api("admin", "POST", `/invoices/${created.body.id}/approve`, {});
    expect(approved.status, `approve ${n}: ${JSON.stringify(approved.body)}`).toBe(200);
    return created.body.id as number;
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('G30 Org','${P}-org','approved') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start) VALUES ($1,'G30 Co','شركة جي ٣٠','1010303030','330033003300303',1) RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('G30 Other','${P}-other','approved') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start) VALUES ($1,'G30 Other Co','1010303031','330033003300313',1) RETURNING id`, [otherOrgId])).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'G30 Buyer','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    const hash = await bcrypt.hash(PW, 4);
    for (const role of ["admin", "bookkeeper"]) {
      ids[role] = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email(role), role, hash])).rows[0].id;
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,'active')`, [ids[role], orgId, role]);
    }
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    for (const who of ["admin", "bookkeeper"]) {
      expect((await api(who, "POST", "/auth/login", { email: email(who), password: PW })).status).toBe(200);
    }
    const main = await api("bookkeeper", "POST", "/bank-accounts", { name: "Main", bankName: "Al Rajhi", currency: "SAR", iban: IBAN_1, isDefault: true, balance: 0, openingBalance: 0 });
    expect(main.status, JSON.stringify(main.body)).toBe(201);
    mainBankId = main.body.id;
    const second = await api("bookkeeper", "POST", "/bank-accounts", { name: "Second", bankName: "SNB", currency: "SAR", iban: IBAN_3, balance: 0, openingBalance: 0 });
    expect(second.status).toBe(201);
    secondBankId = second.body.id;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  it("PREMISE: an invoice issued today prints today's default bank (anti-vacuity)", async () => {
    firstInvoiceId = await issue("G30-001");
    const m = await model(firstInvoiceId);
    expect(m.bankDetails).toEqual({ bankName: "Al Rajhi", iban: IBAN_1, accountName: "Main" });
  });

  it("🔴 changing the bank account's IBAN after issue does NOT change the issued invoice (Arabic and English)", async () => {
    const r = await api("bookkeeper", "PATCH", `/bank-accounts/${mainBankId}`, { iban: IBAN_2, bankName: "Al Rajhi Bank" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const lang of ["ar", "en"] as const) {
      const m = await model(firstInvoiceId, lang);
      expect(m.bankDetails, `${lang} re-render`).toEqual({ bankName: "Al Rajhi", iban: IBAN_1, accountName: "Main" });
      const html = renderInvoiceHtml(m);
      expect(html).toContain(IBAN_1);
      expect(html).not.toContain(IBAN_2);
    }
  });

  it("DIRECT API EXPORT: the issued invoice still exports as a PDF in both languages after the bank change (skips without Chromium)", async () => {
    // The PDF is a pure function of the model asserted above (model → HTML →
    // Chromium → PDF/A-3B). Chromium subsets fonts, so the IBAN is not
    // greppable in the bytes (invoice-document-live.test.ts records the same
    // limit); the HTML above is the asserted artifact, this is the endpoint.
    // CI's API job has no Chromium: the endpoint then answers its NAMED 503,
    // which is the only refusal skipped here — CI's e2e job downloads the PDF
    // (g30-issued-invoice-bank.spec.ts, invoice-document.spec.ts).
    for (const lang of ["ar", "en"]) {
      const res = await fetch(`${base}/invoices/${firstInvoiceId}/document?lang=${lang}`, { headers: { cookie: jar.bookkeeper } });
      if (res.status === 503) {
        const body = (await res.json()) as { code?: string };
        expect(body.code, "a 503 here may only be the named renderer refusal").toBe("pdf_renderer_unavailable");
        // eslint-disable-next-line no-console
        console.warn("[g30] no Chromium executable — export assertions SKIPPED (CI's e2e job covers the download).");
        return;
      }
      expect(res.status, `${lang} export`).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/pdf");
      expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("%PDF");
    }
  });

  it("🔴 switching the DEFAULT bank after issue does not change the issued invoice either", async () => {
    expect((await api("bookkeeper", "PATCH", `/bank-accounts/${secondBankId}`, { isDefault: true })).status).toBe(200);
    const m = await model(firstInvoiceId);
    expect(m.bankDetails).toEqual({ bankName: "Al Rajhi", iban: IBAN_1, accountName: "Main" });
  });

  it("a NEW invoice issued after the change prints the bank in force at ITS issue (movement)", async () => {
    const id = await issue("G30-002");
    expect((await model(id)).bankDetails).toEqual({ bankName: "SNB", iban: IBAN_3, accountName: "Second" });
    // …and the first invoice is still unmoved, beside it.
    expect((await model(firstInvoiceId)).bankDetails?.iban).toBe(IBAN_1);
  });

  it("🔴 the capture is stored on the invoice with the bank account it came from", async () => {
    const { rows } = await pool.query(
      `SELECT issued_bank_account_id, issued_bank_name, issued_bank_iban, issued_bank_account_name FROM invoices WHERE id = $1`,
      [firstInvoiceId],
    );
    expect(rows[0]).toEqual({ issued_bank_account_id: mainBankId, issued_bank_name: "Al Rajhi", issued_bank_iban: IBAN_1, issued_bank_account_name: "Main" });
  });

  it("CREDIT AND DEBIT NOTES print no bank details, before and after a bank change (unchanged rule)", async () => {
    for (const [n, documentType] of [["G30-CN-1", "credit_note"], ["G30-DN-1", "debit_note"]] as const) {
      const id = await issue(n, {
        items: [{ description: "Adjustment", quantity: 1, unitPrice: 100, vatRate: 15 }],
        documentType,
        originalInvoiceId: firstInvoiceId,
        noteReason: "Price correction",
      });
      expect((await model(id)).bankDetails, documentType).toBeNull();
      expect((await api("bookkeeper", "PATCH", `/bank-accounts/${secondBankId}`, { notes: `touched ${n}` })).status).toBe(200);
      expect((await model(id)).bankDetails, `${documentType} after a bank edit`).toBeNull();
    }
  });

  it("🔴 DATABASE: an issued invoice's captured bank details cannot be changed, by any writer", async () => {
    await expect(pool.query(`UPDATE invoices SET issued_bank_iban = $1 WHERE id = $2`, [IBAN_2, firstInvoiceId])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`UPDATE invoices SET issued_bank_account_id = $1 WHERE id = $2`, [secondBankId, firstInvoiceId])).rejects.toMatchObject({ code: "23514" });
    expect((await model(firstInvoiceId)).bankDetails?.iban).toBe(IBAN_1);
  });

  it("🔴 CONCURRENT: an IBAN change racing an issue yields ONE consistent capture, and re-rendering reproduces it", async () => {
    // Back to a known default with a known IBAN.
    expect((await api("bookkeeper", "PATCH", `/bank-accounts/${mainBankId}`, { isDefault: true, iban: IBAN_1, bankName: "Al Rajhi" })).status).toBe(200);
    const created = await api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: "G30-RACE", date: "2026-10-01", customerId,
      items: [{ description: "Race", quantity: 1, unitPrice: 10, vatRate: 15 }],
    });
    expect(created.status).toBe(201);
    const [approved, edited] = await Promise.all([
      api("admin", "POST", `/invoices/${created.body.id}/approve`, {}),
      api("bookkeeper", "PATCH", `/bank-accounts/${mainBankId}`, { iban: IBAN_2, bankName: "Al Rajhi Bank" }),
    ]);
    expect(approved.status).toBe(200);
    expect(edited.status).toBe(200);
    const { rows } = await pool.query(`SELECT issued_bank_name, issued_bank_iban FROM invoices WHERE id = $1`, [created.body.id]);
    const captured = { bankName: rows[0].issued_bank_name, iban: rows[0].issued_bank_iban };
    // Never a torn mix of the two states: the name and IBAN come from one row version.
    expect([{ bankName: "Al Rajhi", iban: IBAN_1 }, { bankName: "Al Rajhi Bank", iban: IBAN_2 }]).toContainEqual(captured);
    // The live bank now holds IBAN_2; the document prints exactly what was captured.
    const m = await model(created.body.id);
    expect({ bankName: m.bankDetails?.bankName, iban: m.bankDetails?.iban }).toEqual(captured);
  });

  it("🔴 CONCURRENT (deterministic): while an issue holds the default bank, an edit of that bank WAITS for it", async () => {
    const defaultId = (await pool.query(`SELECT id FROM bank_accounts WHERE organization_id = $1 AND is_default`, [orgId])).rows[0].id;
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    const other = await pool.connect();
    try {
      const locked = await conn.run(() => bankAccountsRepository.lockDefaultForIssue(companyId));
      expect(locked?.id).toBe(defaultId);
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '300ms'");
      await expect(other.query(`UPDATE bank_accounts SET iban = $1 WHERE id = $2`, [IBAN_3, defaultId])).rejects.toMatchObject({ code: "55P03" });
      await other.query("ROLLBACK");
    } finally {
      await conn.rollback();
      other.release();
    }
    // Released with the issuing transaction: the same edit now goes through.
    const after = await pool.query(`UPDATE bank_accounts SET notes = 'lock released' WHERE id = $1`, [defaultId]);
    expect(after.rowCount).toBe(1);
  });

  it("🔴 DATABASE: an issuing write must capture the default bank AS IT STANDS — a forged IBAN, or no capture, is refused", async () => {
    const created = await api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: "G30-FORGE", date: "2026-10-01", customerId,
      items: [{ description: "Forge", quantity: 1, unitPrice: 10, vatRate: 15 }],
    });
    expect(created.status).toBe(201);
    const bank = (await pool.query(`SELECT id, bank_name, iban, name FROM bank_accounts WHERE organization_id = $1 AND is_default`, [orgId])).rows[0];
    const issue = (capture: [number | null, string | null, string | null, string | null]) =>
      pool.query(
        `UPDATE invoices SET status = 'sent', invoice_hash = 'x', previous_hash = 'y', seller_name = 'G30 Co', seller_vat_number = '330033003300303',
                issued_bank_account_id = $1, issued_bank_name = $2, issued_bank_iban = $3, issued_bank_account_name = $4, issued_at = now()
          WHERE id = $5`,
        [...capture, created.body.id],
      );
    await expect(issue([bank.id, bank.bank_name, "SA0000000000000000000000", bank.name])).rejects.toMatchObject({ code: "23514" });
    await expect(issue([null, null, null, null])).rejects.toMatchObject({ code: "23514" });
    expect((await pool.query(`SELECT status FROM invoices WHERE id = $1`, [created.body.id])).rows[0].status).toBe("draft");
  });

  it("a bank account named on an issued invoice cannot be DELETED — a named 409, and the account is kept", async () => {
    const r = await api("admin", "DELETE", `/bank-accounts/${secondBankId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(String(r.body?.error)).toContain("issued invoice");
    expect((await pool.query(`SELECT count(*)::int AS n FROM bank_accounts WHERE id = $1`, [secondBankId])).rows[0].n).toBe(1);
  });

  it("CROSS-TENANT: another organization's bank changes never reach this tenant's issued invoice", async () => {
    await tenant(otherOrgId, otherCompanyId)(() =>
      bankAccountsService.create({ name: "Main", bankName: "Alinma", currency: "SAR", iban: IBAN_2, isDefault: true }),
    );
    expect((await model(firstInvoiceId)).bankDetails?.iban).toBe(IBAN_1);
    // …and the other tenant cannot read this tenant's invoice at all.
    await expect(tenant(otherOrgId, otherCompanyId)(() => invoicesService.getById(firstInvoiceId))).rejects.toMatchObject({ statusCode: 404 });
  });

  /**
   * 🔴 REGRESSION (owner review of PR #192, 2026-10-07): the snapshot is
   * compared with the company's default bank ONLY by the issuing write. A
   * historical invoice must never be re-validated against TODAY's default —
   * a later default change, an IBAN edit or a deactivation of the bank it
   * names are all legitimate, and an ordinary later update of that invoice
   * (here: recording its payment) must still succeed with the snapshot intact.
   */
  it("🔴 REGRESSION: a historical invoice stays valid and unchanged after the default moves, its bank is edited and deactivated, and it is paid", async () => {
    const a = await api("bookkeeper", "POST", "/bank-accounts", { name: "Reg A", bankName: "Al Rajhi", currency: "SAR", iban: IBAN_1, isDefault: true, balance: 0, openingBalance: 0 });
    const b = await api("bookkeeper", "POST", "/bank-accounts", { name: "Reg B", bankName: "SNB", currency: "SAR", iban: IBAN_3, balance: 0, openingBalance: 0 });
    expect([a.status, b.status]).toEqual([201, 201]);
    const SNAP_A = { issued_bank_account_id: a.body.id, issued_bank_name: "Al Rajhi", issued_bank_iban: IBAN_1, issued_bank_account_name: "Reg A" };
    const SNAP_B = { issued_bank_account_id: b.body.id, issued_bank_name: "SNB", issued_bank_iban: IBAN_3, issued_bank_account_name: "Reg B" };
    const snapshot = async (id: number) =>
      (await pool.query(`SELECT issued_bank_account_id, issued_bank_name, issued_bank_iban, issued_bank_account_name FROM invoices WHERE id = $1`, [id])).rows[0];
    const printed = { A: { bankName: "Al Rajhi", iban: IBAN_1, accountName: "Reg A" }, B: { bankName: "SNB", iban: IBAN_3, accountName: "Reg B" } };

    // 1. issue an invoice using Bank A
    const first = await issue("G30-REG-1");
    expect(await snapshot(first)).toEqual(SNAP_A);

    // 2. change the company default to Bank B; 3. issue a second invoice
    expect((await api("bookkeeper", "PATCH", `/bank-accounts/${b.body.id}`, { isDefault: true })).status).toBe(200);
    const second = await issue("G30-REG-2");
    expect(await snapshot(second)).toEqual(SNAP_B);

    // Amendment A: an ordinary later UPDATE of the first invoice — its
    // payment — succeeds although today's default is Bank B, and leaves the
    // Bank A snapshot untouched.
    const paid = await api("admin", "POST", `/invoices/${first}/pay`, { amount: 1150, paidAt: "2026-10-02", bankAccountId: b.body.id });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const after = (await pool.query(`SELECT status, paid_amount FROM invoices WHERE id = $1`, [first])).rows[0];
    expect(after.status).toBe("paid");
    expect(Number(after.paid_amount)).toBe(1150);
    expect(await snapshot(first), "a payment does not touch the snapshot").toEqual(SNAP_A);

    // Amendment A: edit Bank A's IBAN, then deactivate Bank A.
    expect((await api("bookkeeper", "PATCH", `/bank-accounts/${a.body.id}`, { iban: IBAN_2 })).status).toBe(200);
    expect((await api("bookkeeper", "PATCH", `/bank-accounts/${a.body.id}`, { isActive: false })).status).toBe(200);
    const liveA = (await pool.query(`SELECT iban, is_active, is_default FROM bank_accounts WHERE id = $1`, [a.body.id])).rows[0];
    expect(liveA, "the bank account itself DID change (movement)").toEqual({ iban: IBAN_2, is_active: false, is_default: false });

    // 4.–7. both invoices remain valid documents and each renders its own
    // issue-time bank, in both languages; neither is refused because the
    // current default differs from what it printed.
    for (const lang of ["ar", "en"] as const) {
      const m1 = await model(first, lang);
      const m2 = await model(second, lang);
      expect(m1.bankDetails, `${lang}: the first invoice still prints Bank A as issued`).toEqual(printed.A);
      expect(m2.bankDetails, `${lang}: the second invoice prints Bank B`).toEqual(printed.B);
      expect(renderInvoiceHtml(m1)).toContain(IBAN_1);
      expect(renderInvoiceHtml(m1)).not.toContain(IBAN_2);
    }
    expect(await snapshot(first)).toEqual(SNAP_A);
    expect(await snapshot(second)).toEqual(SNAP_B);
  });
});
