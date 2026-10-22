/**
 * PHASE 18 · PR C (issued-invoice freeze) · G49 PROOF — the 0121 freeze is keyed on
 * `invoice_hash IS NOT NULL`, so clearing the hash first takes an issued invoice out of
 * the freeze. PROOF ONLY, NOT A FIX. Untracked; never merged red; never weakened.
 *
 * Audit row G49 (MEDIUM): "0121 freeze keyed on invoice_hash IS NOT NULL; clearing the hash
 * bypasses it in two statements". The same key guards the AP-2 prepayment freeze (0083,
 * `refuse_issued_prepayment_change`), so it is exercised here too.
 *
 * The mechanism (read at origin/main f10c2a6a):
 *  - 0121 `guard_invoice_issued_identity` (BEFORE UPDATE): OLD.invoice_hash NOT NULL → the
 *    seller and bank-capture columns are frozen; NEW.invoice_hash NULL → nothing is checked;
 *    hash NULL → set (the "issuing write") → seller must equal the company's, and a 388's
 *    bank capture must equal the company's default bank;
 *  - 0121 CHECK `invoices_issued_bank_capture_scope_chk`: a bank capture needs a hash;
 *  - 0083 `refuse_issued_prepayment_change`: frozen only while the invoice's hash is set.
 *
 * FIX-NEUTRAL invariant, per case: after the WHOLE sequence is attempted (each statement
 * attempted whatever the previous one did), the issued invoice still carries the hash, the
 * seller identity and the prepayment rows it was issued with. Each statement is reported.
 * Every subject is produced by the product's own HTTP path (create → approve).
 * Company NOT ZATCA-onboarded (the guard under test is the database's; onboarding is not
 * involved in it). Both connections: the OWNER (`pool`, autocommit) and the APP ROLE
 * (`SET LOCAL ROLE authenticated` + tenant GUCs, one committed transaction per statement).
 *
 * 🔴 Expected to FAIL while G49 exists. DB-backed (sl_test); skips on the DB-free placeholder.
 */

process.env.PORT ??= "3183";
process.env.SESSION_SECRET ??= "phase18-prc-g49-proof-session-secret-00001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "PrcG49ProofPw123!";
const DATE = "2026-10-05";
const VAT = "399999999994013";
const NAME = "PRC G49 Co";
const IMPOSTOR = { name: "PRC Impostor Trading", vat: "300000000000003" };

type Role = "owner" | "app";
type Attempt = { refused: boolean; rowCount: number | null; code: string | null; constraint: string | null; message: string | null };

describeMaybe("PR C proof · G49 — clearing invoice_hash takes an issued invoice out of the 0121 / 0083 freezes", () => {
  const h = g04Harness("prcg49");
  let orgId = "";
  let companyId = "";
  let customerId = 0;
  let bank = 0;

  const fail = (e: unknown): Attempt => {
    const err = e as { code?: string; constraint?: string; message?: string };
    return { refused: true, rowCount: null, code: err.code ?? null, constraint: err.constraint ?? null, message: String(err.message ?? e).slice(0, 220) };
  };
  async function asOwner(sql: string, params: unknown[]): Promise<Attempt> {
    try {
      const r = await pool.query(sql, params);
      return { refused: false, rowCount: r.rowCount, code: null, constraint: null, message: null };
    } catch (e) {
      return fail(e);
    }
  }
  async function asApp(sql: string, params: unknown[]): Promise<Attempt> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE authenticated`);
      await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
      await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
      try {
        const r = await c.query(sql, params);
        await c.query("COMMIT");
        return { refused: false, rowCount: r.rowCount, code: null, constraint: null, message: null };
      } catch (e) {
        await c.query("ROLLBACK");
        return fail(e);
      }
    } finally {
      c.release();
    }
  }
  const as = (role: Role, sql: string, params: unknown[]) => (role === "owner" ? asOwner(sql, params) : asApp(sql, params));
  /** Each statement in order, every one attempted whatever the previous did; returns the outcomes. */
  async function sequence(role: Role, steps: Array<[string, string, unknown[]]>): Promise<Array<[string, Attempt]>> {
    const out: Array<[string, Attempt]> = [];
    for (const [label, sql, params] of steps) out.push([label, await as(role, sql, params)]);
    return out;
  }
  const brief = (steps: Array<[string, Attempt]>) => steps.map(([l, a]) => `${l}: ${a.refused ? `REFUSED (${a.code}${a.constraint ? ` ${a.constraint}` : ""})` : `applied (rowCount ${a.rowCount})`}`);

  const rowOf = async (id: number) => (await pool.query(
    `SELECT id, status, document_type, invoice_hash, icv, seller_name, seller_vat_number, issued_bank_account_id FROM invoices WHERE id = $1`, [id],
  )).rows[0] ?? null;
  const prepaymentsOf = async (id: number) => (await pool.query(
    `SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb) AS r FROM invoice_prepayments p WHERE invoice_id = $1`, [id],
  )).rows[0].r as unknown[];
  const companyNow = async () => (await pool.query(`SELECT name, vat_number FROM companies WHERE id = $1`, [companyId])).rows[0];
  const restoreCompany = () => pool.query(`UPDATE companies SET name = $2, vat_number = $3 WHERE id = $1`, [companyId, NAME, VAT]);

  const line = (unitPrice: number) => [{ description: "Professional services", quantity: 1, unitPrice, vatRate: 15 }];
  async function create(body: Record<string, unknown>): Promise<number> {
    const r = await h.api("bookkeeper", "POST", "/invoices", { date: DATE, customerId, ...body });
    expect(r.status, `create: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  }
  async function approve(id: number) {
    const r = await h.api("accountant", "POST", `/invoices/${id}/approve`, {});
    expect(r.status, `approve ${id}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  const issued = async (body: Record<string, unknown> = { items: line(1_000) }) => {
    const id = await create(body);
    await approve(id);
    return id;
  };
  /** A 388 that adjusts a 386 — receipt (advance) → 386 → approve → final invoice → approve. */
  async function issuedWithPrepayment(): Promise<number> {
    const receipt = await h.api("admin", "POST", "/payments", { customerId, amount: 1_150, paidAt: DATE, bankAccountId: bank, classification: "advance", vatCategory: "S" });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const adv = await h.api("admin", "POST", `/payments/${receipt.body.id}/advance-invoices`, { amount: 1_150 });
    expect(adv.status, JSON.stringify(adv.body)).toBe(201);
    await approve(adv.body.id);
    return issued({ items: line(2_000), prepayments: [{ advanceInvoiceId: adv.body.id, amount: 1_150 }] });
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start) VALUES ($1,$2,'شركة','1010101010',$3,1) RETURNING id`, [orgId, NAME, VAT],
    )).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'PRC G49 Client','عميل') RETURNING id`, [orgId])).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    // A bank for the receipts — NOT the default yet, so the invoices issued first capture no bank (G30).
    const b = await h.api("admin", "POST", "/bank-accounts", { name: "PRC G49 Main", bankName: "Riyad Bank", iban: "SA0380000000608010167519", currency: "SAR" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    bank = b.body.id;
  }, 120_000);

  afterAll(async () => {
    await restoreCompany();
    await h.stop();
    await h.cleanup();
  });

  it("PREMISE + CONTROL: an issued invoice carries hash, ICV, the company's seller identity and NO bank capture (no default bank); a SINGLE-statement seller change is REFUSED by 0121 for both connections; a draft is writable by the app role", async () => {
    const id = await issued();
    const before = await rowOf(id);
    const owner = await asOwner(`UPDATE invoices SET seller_name = $2, seller_vat_number = $3 WHERE id = $1`, [id, IMPOSTOR.name, IMPOSTOR.vat]);
    const app = await asApp(`UPDATE invoices SET seller_name = $2, seller_vat_number = $3 WHERE id = $1`, [id, IMPOSTOR.name, IMPOSTOR.vat]);
    const draftId = await create({ items: line(500) });
    const draftWrite = await asApp(`UPDATE invoices SET notes = 'prc control' WHERE id = $1`, [draftId]);
    // eslint-disable-next-line no-console
    console.warn("[PRC G49] PREMISE/CONTROL", JSON.stringify({ issued: before, singleStatement: { owner, app }, draftWrite }));
    expect(before.status).toBe("sent");
    expect(before.invoice_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(before.icv).not.toBeNull();
    expect([before.seller_name, before.seller_vat_number]).toEqual([NAME, VAT]);
    expect(before.issued_bank_account_id).toBeNull();
    expect([owner.refused, owner.constraint, app.refused, app.constraint]).toEqual([true, "invoice_issued_identity_frozen", true, "invoice_issued_identity_frozen"]);
    expect(await rowOf(id)).toEqual(before);
    expect([draftWrite.refused, draftWrite.rowCount]).toEqual([false, 1]);
  }, 60_000);

  for (const role of ["owner", "app"] as const) {
    it(`🔴 G49 (388, no bank capture) · ${role}: clear the hash → change the seller → restore the hash — the issued invoice keeps its hash AND its seller identity`, async () => {
      const id = await issued();
      const before = await rowOf(id);
      const steps = await sequence(role, [
        ["1 clear invoice_hash", `UPDATE invoices SET invoice_hash = NULL WHERE id = $1`, [id]],
        ["2 change seller", `UPDATE invoices SET seller_name = $2, seller_vat_number = $3 WHERE id = $1`, [id, IMPOSTOR.name, IMPOSTOR.vat]],
        ["3 restore invoice_hash", `UPDATE invoices SET invoice_hash = $2 WHERE id = $1`, [id, before.invoice_hash]],
      ]);
      const after = await rowOf(id);
      const shown = await h.api("accountant", "GET", `/invoices/${id}`);
      // eslint-disable-next-line no-console
      console.warn(`[PRC G49] 388 ${role}`, JSON.stringify({ invoiceId: id, steps: brief(steps), detail: steps, before, after, productShows: { http: shown.status, status: shown.body?.status } }));
      expect.soft(after.invoice_hash, "the issued hash is still there").toBe(before.invoice_hash);
      expect.soft([after.seller_name, after.seller_vat_number], "the seller identity is the one it was issued under").toEqual([before.seller_name, before.seller_vat_number]);
    }, 60_000);

    it(`🔴 G49 (388, full round trip through the company row) · ${role}: clear hash → change the company → set the invoice's seller to it → restore hash → restore the company — the issued invoice keeps its seller identity`, async () => {
      const id = await issued();
      const before = await rowOf(id);
      let steps: Array<[string, Attempt]> = [];
      try {
        steps = await sequence(role, [
          ["1 clear invoice_hash", `UPDATE invoices SET invoice_hash = NULL WHERE id = $1`, [id]],
          ["2 change the company's name + VAT", `UPDATE companies SET name = $2, vat_number = $3 WHERE id = $1`, [companyId, IMPOSTOR.name, IMPOSTOR.vat]],
          ["3 set the invoice seller to the company's new identity", `UPDATE invoices SET seller_name = $2, seller_vat_number = $3 WHERE id = $1`, [id, IMPOSTOR.name, IMPOSTOR.vat]],
          ["4 restore invoice_hash (the issuing-write check)", `UPDATE invoices SET invoice_hash = $2 WHERE id = $1`, [id, before.invoice_hash]],
          ["5 restore the company", `UPDATE companies SET name = $2, vat_number = $3 WHERE id = $1`, [companyId, NAME, VAT]],
        ]);
      } finally {
        await restoreCompany();
      }
      const after = await rowOf(id);
      // eslint-disable-next-line no-console
      console.warn(`[PRC G49] 388 round-trip ${role}`, JSON.stringify({ invoiceId: id, steps: brief(steps), detail: steps, before, after, companyAfter: await companyNow() }));
      expect.soft(after.invoice_hash, "the issued hash is still there").toBe(before.invoice_hash);
      expect.soft([after.seller_name, after.seller_vat_number], "the seller identity is the one it was issued under").toEqual([before.seller_name, before.seller_vat_number]);
    }, 60_000);

    it(`🔴 G49 (381 credit note — never carries a bank capture) · ${role}: clear hash → change seller → restore hash — the note keeps its hash AND its seller identity`, async () => {
      const original = await issued({ items: line(2_000) });
      const id = await issued({ documentType: "credit_note", originalInvoiceId: original, noteReason: "Price reduced", items: line(100) });
      const before = await rowOf(id);
      expect(before.document_type).toBe("credit_note");
      const steps = await sequence(role, [
        ["1 clear invoice_hash", `UPDATE invoices SET invoice_hash = NULL WHERE id = $1`, [id]],
        ["2 change seller", `UPDATE invoices SET seller_name = $2, seller_vat_number = $3 WHERE id = $1`, [id, IMPOSTOR.name, IMPOSTOR.vat]],
        ["3 restore invoice_hash", `UPDATE invoices SET invoice_hash = $2 WHERE id = $1`, [id, before.invoice_hash]],
      ]);
      const after = await rowOf(id);
      // eslint-disable-next-line no-console
      console.warn(`[PRC G49] 381 ${role}`, JSON.stringify({ invoiceId: id, steps: brief(steps), detail: steps, before, after }));
      expect.soft(after.invoice_hash).toBe(before.invoice_hash);
      expect.soft([after.seller_name, after.seller_vat_number]).toEqual([before.seller_name, before.seller_vat_number]);
    }, 60_000);

    it(`🔴 G49 (0083 prepayment freeze, 388 adjusting a 386) · ${role}: a direct DELETE of the prepayment row is refused; clear hash → delete it → restore hash — the issued invoice keeps the prepayment rows it was issued with`, async () => {
      const id = await issuedWithPrepayment();
      const before = await rowOf(id);
      const rows = await prepaymentsOf(id);
      expect(rows.length, "premise: the issued 388 states one prepayment adjustment").toBe(1);
      const direct = await as(role, `DELETE FROM invoice_prepayments WHERE invoice_id = $1`, [id]);
      expect([direct.refused, direct.constraint], "control: the 0083 freeze refuses a direct delete while the hash is set").toEqual([true, "prepayment_issued_frozen"]);
      const steps = await sequence(role, [
        ["1 clear invoice_hash", `UPDATE invoices SET invoice_hash = NULL WHERE id = $1`, [id]],
        ["2 delete the prepayment adjustment", `DELETE FROM invoice_prepayments WHERE invoice_id = $1`, [id]],
        ["3 restore invoice_hash", `UPDATE invoices SET invoice_hash = $2 WHERE id = $1`, [id, before.invoice_hash]],
      ]);
      const after = await rowOf(id);
      const rowsAfter = await prepaymentsOf(id);
      // eslint-disable-next-line no-console
      console.warn(`[PRC G49] 0083 ${role}`, JSON.stringify({ invoiceId: id, direct, steps: brief(steps), detail: steps, hashBefore: before.invoice_hash, hashAfter: after.invoice_hash, prepaymentRowsBefore: rows.length, prepaymentRowsAfter: rowsAfter.length }));
      expect.soft(after.invoice_hash).toBe(before.invoice_hash);
      expect.soft(rowsAfter, "the prepayment adjustment the signed document states is still there").toEqual(rows);
    }, 90_000);
  }

  for (const role of ["owner", "app"] as const) {
    it(`🔴 G49-adjacent (the INSERT path; 0121 is BEFORE UPDATE only — its header, lines 26-27) · ${role}: a row INSERTED already issued (hash set) under a seller that is not the company's is REFUSED`, async () => {
      const number = `PRC-INSERTED-${role}`;
      const r = await as(role,
        `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, status, subtotal, vat_amount, total,
                               invoice_hash, previous_hash, qr_code, seller_name, seller_vat_number, icv, zatca_uuid, issued_at)
         VALUES ($1, $2, $3, $4, 'invoice', $5, 'sent', 1000, 150, 1150, repeat('a', 64), 'GENESIS', 'cHJj', $6, $7, $8, gen_random_uuid(), now())`,
        [orgId, companyId, customerId, number, DATE, IMPOSTOR.name, IMPOSTOR.vat, role === "owner" ? 900_001 : 900_002]);
      const row = (await pool.query(`SELECT id, status, invoice_hash IS NOT NULL AS hashed, seller_name, seller_vat_number, icv FROM invoices WHERE company_id = $1 AND invoice_number = $2`, [companyId, number])).rows[0] ?? null;
      // eslint-disable-next-line no-console
      console.warn(`[PRC G49] INSERT issued ${role}`, JSON.stringify({ attempt: r, row }));
      expect.soft(r.refused, "the database refuses an issued row it did not issue").toBe(true);
      expect.soft(row, "no such row exists").toBeNull();
    }, 60_000);
  }

  it("G49 boundary (388 WITH a bank capture — the company has a default bank): each step is refused — clearing the hash alone by the CHECK, clearing hash + capture together and the seller change by 0121 — and the invoice is unchanged (expected to PASS: not reproduced on this shape)", async () => {
    const flip = await h.api("admin", "PATCH", `/bank-accounts/${bank}`, { isDefault: true });
    expect(flip.status, JSON.stringify(flip.body)).toBe(200);
    const out: Record<string, unknown> = {};
    for (const role of ["owner", "app"] as const) {
      const id = await issued();
      const before = await rowOf(id);
      expect(before.issued_bank_account_id, "premise: the 388 captured the default bank").toBe(bank);
      const steps = await sequence(role, [
        ["1 clear invoice_hash alone", `UPDATE invoices SET invoice_hash = NULL WHERE id = $1`, [id]],
        ["1b clear invoice_hash and the bank capture together", `UPDATE invoices SET invoice_hash = NULL, issued_bank_account_id = NULL, issued_bank_name = NULL, issued_bank_iban = NULL, issued_bank_account_name = NULL WHERE id = $1`, [id]],
        ["2 change seller", `UPDATE invoices SET seller_name = $2, seller_vat_number = $3 WHERE id = $1`, [id, IMPOSTOR.name, IMPOSTOR.vat]],
      ]);
      const after = await rowOf(id);
      out[role] = { invoiceId: id, steps: brief(steps), detail: steps };
      expect.soft(after, `${role}: unchanged`).toEqual(before);
      expect.soft(steps.map(([, a]) => a.constraint), role).toEqual(["invoices_issued_bank_capture_scope_chk", "invoice_issued_identity_frozen", "invoice_issued_identity_frozen"]);
    }
    // eslint-disable-next-line no-console
    console.warn("[PRC G49] bank-captured boundary", JSON.stringify(out));
  }, 90_000);
});
