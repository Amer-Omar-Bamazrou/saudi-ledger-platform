/**
 * MED validation pass (audit 2026-08-20, fixed 2026-08-23).
 *
 *  - Reference ids in request bodies (customerId / vendorId / categoryId) are
 *    pre-checked through the TENANT-SCOPED repository and refuse with 422
 *    `reference_not_found` — not a raw FK 500. 🔴 The load-bearing case is the
 *    cross-tenant one: Postgres runs FK checks OUTSIDE RLS, so before this fix
 *    the database ACCEPTED another tenant's customer id. Under RLS the lookup
 *    cannot see that row, so missing and other-tenant ids are the same refusal.
 *  - `taxCategoryCode` ∈ {S,Z,E,O,null}: named 400 at the service, DB CHECK
 *    (0056) as the write-boundary backstop — both directions tested.
 *  - transactions.vat_amount / vat_rate: PATCH schema now carries the create
 *    path's bounds, and the DB CHECK (0056) binds every writer.
 *  - A draft invoice/bill can no longer be re-DATED into a closed month by
 *    PATCH when create refuses the same date (owner policy 2026-08-23: the
 *    guard honours document.date — the accounting date the VAT return reads).
 *  - requireIdParam / parseJsonField: the shared helpers behind the ~9
 *    controllers' NaN-id 500s and the capture route's silently-dropped OCR.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Request } from "express";
import { beginTenantConnection, pool } from "@workspace/db";
import { UpdateTransactionBody } from "@workspace/api-zod";
import { auditContext } from "../lib/auditContext";
import { requireIdParam, parseJsonField } from "../lib/httpParams";
import { assertTaxCategoryCode } from "../lib/writeGuards";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { quotationsService } from "../services/quotations.service";
import { transactionsService } from "../services/transactions.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[audit-med-validation] no real DATABASE_URL — skipping DB half.");

// ── Unit half (no DB) ───────────────────────────────────────────────────────

describe("requireIdParam — ids validated, not merely coerced", () => {
  const reqWith = (id: string) => ({ params: { id } }) as unknown as Request;

  it("accepts a positive integer id", () => {
    expect(requireIdParam(reqWith("42"))).toBe(42);
  });

  it.each(["abc", "NaN", "-1", "0", "1.5", ""])("rejects %j with a 400", (bad) => {
    expect(() => requireIdParam(reqWith(bad))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("validates a named param (userId)", () => {
    const req = { params: { userId: "banana" } } as unknown as Request;
    expect(() => requireIdParam(req, "userId")).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});

describe("parseJsonField — malformed JSON refuses, never silently drops", () => {
  it("absent and blank are valid (the field is optional)", () => {
    expect(parseJsonField(undefined, "extraction")).toBeUndefined();
    expect(parseJsonField(null, "extraction")).toBeUndefined();
    expect(parseJsonField("   ", "extraction")).toBeUndefined();
  });

  it("valid JSON parses", () => {
    expect(parseJsonField('{"vendor":"ACME"}', "extraction")).toEqual({ vendor: "ACME" });
  });

  it("🔴 malformed JSON throws a 400 naming the field — the old catch→undefined staged the capture with the OCR lost", () => {
    expect(() => parseJsonField("{not json", "extraction")).toThrowError(/extraction is not valid JSON/);
    expect(() => parseJsonField(123, "fieldSources")).toThrowError(/fieldSources must be a JSON string/);
  });
});

describe("assertTaxCategoryCode — S/Z/E/O or null, nothing else", () => {
  it("accepts the four codes and null/undefined (0% is genuinely ambiguous — never guessed)", () => {
    for (const ok of ["S", "Z", "E", "O", null, undefined]) {
      expect(() => assertTaxCategoryCode(ok, "taxCategoryCode")).not.toThrow();
    }
  });
  it.each(["X", "s", "SS", "", "VATEX-SA-29", 5])("rejects %j", (bad) => {
    expect(() => assertTaxCategoryCode(bad, "taxCategoryCode")).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});

describe("UpdateTransactionBody — PATCH carries the create path's VAT bounds", () => {
  it("🔴 negative vatAmount no longer passes the PATCH schema (cross-path inconsistency, audit MED)", () => {
    expect(UpdateTransactionBody.safeParse({ vatAmount: -5 }).success).toBe(false);
  });
  it("vatRate above 100 fails; the create-path bounds now hold on PATCH too", () => {
    expect(UpdateTransactionBody.safeParse({ vatRate: 150 }).success).toBe(false);
    expect(UpdateTransactionBody.safeParse({ vatRate: -1 }).success).toBe(false);
  });
  it("in-range values still pass (the fix narrows, it does not break)", () => {
    expect(UpdateTransactionBody.safeParse({ vatAmount: 15, vatRate: 15 }).success).toBe(true);
    expect(UpdateTransactionBody.safeParse({ vatAmount: null, vatRate: null }).success).toBe(true);
  });
});

// ── DB half ─────────────────────────────────────────────────────────────────

const SLUG = "med-validation";
const SLUG_B = "med-validation-b";
const EMAIL = "med-validation@test.local";

/**
 * 🔴 FIXTURE NOTE (2026-08-28): these creates used to pass `items: []`.
 *
 * `invoicesService.create` now refuses a line-less invoice — it would be issued
 * at SAR 0.00, consuming an ICV and a ZATCA chain position irreversibly — so
 * the fixtures carry a real line. Nothing these tests ASSERT has changed: they
 * are about reference validation (422) and re-dating into a closed period
 * (423), and a realistic fixture exercises both the same way.
 *
 * One of them ("create with the tenant's OWN customer still succeeds") was
 * implicitly asserting that a line-less invoice is creatable. That assertion
 * expired the day the rule landed.
 */
describeMaybe("MED validation — reference ids, tax enum, vat bounds, re-dating", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let vendorId = 0;
  let orgBId = "";
  let orgBCustomerId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    for (const slug of [SLUG, SLUG_B]) {
      const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
      await pool.query(`DELETE FROM quotation_conversions WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM quotation_items WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM quotations WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM transactions WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM bill_items WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM period_locks WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM invoice_number_counters WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
      await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    }
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN (SELECT id FROM users WHERE email = '${EMAIL}')`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM organizations WHERE slug IN ('${SLUG}','${SLUG_B}')`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('MED Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'MED','1010101018','399999999900003') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','MED',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'MED Client') RETURNING id`, [orgId])
    ).rows[0].id;
    vendorId = (
      await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'MED Supplier') RETURNING id`, [orgId])
    ).rows[0].id;

    // Org B exists ONLY to hold the customer org A must not be able to reference.
    orgBId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('MED Org B','${SLUG_B}') RETURNING id`)).rows[0].id;
    orgBCustomerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Other Tenant Client') RETURNING id`, [orgBId])
    ).rows[0].id;
  });

  afterAll(cleanup);

  const NONEXISTENT = 99_999_999;

  // ── Reference ids: 422, tenant-scoped ─────────────────────────────────────

  it("invoice create with a nonexistent customerId → 422 reference_not_found (was a raw FK 500)", async () => {
    await expect(
      inTenant(() => invoicesService.create({ date: "2026-07-10", customerId: NONEXISTENT, items: [{ description: "Line", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId)),
    ).rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "reference_not_found", field: "customerId" }) });
  });

  it("🔴 invoice create with ANOTHER TENANT's customerId → the same 422 — the FK check runs outside RLS and used to accept it", async () => {
    // Prove the premise first: the row exists, so only tenant scoping can hide it.
    const { rows } = await pool.query(`SELECT id FROM customers WHERE id = $1`, [orgBCustomerId]);
    expect(rows).toHaveLength(1);
    await expect(
      inTenant(() => invoicesService.create({ date: "2026-07-10", customerId: orgBCustomerId, items: [{ description: "Line", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId)),
    ).rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "reference_not_found" }) });
  });

  it("invoice create with the tenant's OWN customer still succeeds (the fix narrows, it does not break)", async () => {
    const out = await inTenant(() => invoicesService.create({ date: "2026-07-10", customerId, items: [{ description: "Line", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId));
    expect(out.customerId).toBe(customerId);
  });

  it("bill create with a nonexistent vendorId → 422", async () => {
    await expect(
      inTenant(() => billsService.create({ date: "2026-07-10", vendorId: NONEXISTENT, items: [{ description: "Line", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId)),
    ).rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "reference_not_found", field: "vendorId" }) });
  });

  it("quotation create with a nonexistent customerId → 422 (sibling path, same rule)", async () => {
    await expect(
      inTenant(() =>
        quotationsService.create(
          { customerId: NONEXISTENT, items: [{ description: "Widget", quantity: 1, unitPrice: 100 }] },
          userId,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "reference_not_found" }) });
  });

  it("SINGLE transaction create with a nonexistent categoryId → 422 (the bulk path mapped it; the single path 500'd)", async () => {
    await expect(
      inTenant(() =>
        transactionsService.create({
          date: "2026-07-10",
          description: "MED bad category",
          amount: 100,
          type: "debit",
          categoryId: NONEXISTENT,
        } as never),
      ),
    ).rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "reference_not_found", field: "categoryId" }) });
  });

  it("transaction PATCH assigning a nonexistent categoryId → 422", async () => {
    const tx = await inTenant(() =>
      transactionsService.create({ date: "2026-07-10", description: "MED patch target", amount: 50, type: "debit" } as never),
    );
    await expect(
      inTenant(() => transactionsService.update(tx.id, { categoryId: NONEXISTENT } as never)),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  // ── taxCategoryCode: named 400 + DB CHECK backstop ────────────────────────

  it("invoice create with taxCategoryCode 'X' on a line → named 400, nothing written", async () => {
    const before = (await pool.query(`SELECT count(*) FROM invoices WHERE organization_id = $1`, [orgId])).rows[0].count;
    await expect(
      inTenant(() =>
        invoicesService.create(
          { date: "2026-07-10", items: [{ description: "W", quantity: 1, unitPrice: 100, vatRate: 15, taxCategoryCode: "X" }] },
          userId,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    const after = (await pool.query(`SELECT count(*) FROM invoices WHERE organization_id = $1`, [orgId])).rows[0].count;
    expect(after).toBe(before);
  });

  it("🔴 DB CHECK 0056 refuses a garbage code on invoice_items even from a writer that skips the service", async () => {
    const inv = await inTenant(() =>
      invoicesService.create(
        { date: "2026-07-10", items: [{ description: "W", quantity: 1, unitPrice: 100, vatRate: 15 }] },
        userId,
      ),
    );
    const { rows } = await pool.query(`SELECT id FROM invoice_items WHERE invoice_id = $1`, [inv.id]);
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      pool.query(`UPDATE invoice_items SET tax_category_code = 'X' WHERE id = $1`, [rows[0].id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("DB CHECK 0056 covers quotation_items too (the column conversion copies from)", async () => {
    const quo = await inTenant(() =>
      quotationsService.create({ customerId, items: [{ description: "W", quantity: 1, unitPrice: 100 }] }, userId),
    );
    const { rows } = await pool.query(`SELECT id FROM quotation_items WHERE quotation_id = $1`, [quo.id]);
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      pool.query(`UPDATE quotation_items SET tax_category_code = 'bogus' WHERE id = $1`, [rows[0].id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  // ── transactions VAT bounds: the DB is the write boundary ─────────────────

  it("🔴 DB CHECK 0056 refuses a negative vat_amount and an out-of-range vat_rate on transactions", async () => {
    const tx = await inTenant(() =>
      transactionsService.create({ date: "2026-07-10", description: "MED vat bounds", amount: 100, type: "debit" } as never),
    );
    await expect(pool.query(`UPDATE transactions SET vat_amount = -5 WHERE id = $1`, [tx.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`UPDATE transactions SET vat_rate = 150 WHERE id = $1`, [tx.id])).rejects.toMatchObject({ code: "23514" });
  });

  // ── Re-dating a draft into a closed month ─────────────────────────────────

  it("🔴 PATCHing a draft invoice's date into a closed month → 423 period_closed (create refused it; PATCH did not)", async () => {
    const inv = await inTenant(() => invoicesService.create({ date: "2026-07-15", items: [{ description: "Line", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId));
    expect(inv.status).toBe("draft");
    await pool.query(
      `INSERT INTO period_locks (organization_id, company_id, period) VALUES ($1,$2,'2026-06') ON CONFLICT DO NOTHING`,
      [orgId, companyId],
    );
    await expect(
      inTenant(() => invoicesService.update(inv.id, { date: "2026-06-10" })),
    ).rejects.toMatchObject({ statusCode: 423, payload: expect.objectContaining({ code: "period_closed", period: "2026-06" }) });
    // The date must be unchanged — the refusal happened before the write.
    const { rows } = await pool.query(`SELECT date FROM invoices WHERE id = $1`, [inv.id]);
    expect(rows[0].date).toBe("2026-07-15");
  });

  it("the bill twin: PATCHing a draft bill's date into the closed month → 423", async () => {
    const bill = await inTenant(() =>
      billsService.create({ billNumber: "MED-BILL-1", date: "2026-07-15", vendorId, items: [{ description: "Line", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId),
    );
    await expect(
      inTenant(() => billsService.update(bill.id, { date: "2026-06-10" })),
    ).rejects.toMatchObject({ statusCode: 423, payload: expect.objectContaining({ code: "period_closed" }) });
  });

  it("re-dating a draft into an OPEN month still works (the guard checks the new date, not the act of editing)", async () => {
    const inv = await inTenant(() => invoicesService.create({ date: "2026-07-15", items: [{ description: "Line", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId));
    const out = await inTenant(() => invoicesService.update(inv.id, { date: "2026-08-05" }));
    expect(out.date).toBe("2026-08-05");
  });
});
