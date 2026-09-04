/**
 * QA FIX #1 — CREATE IS IDEMPOTENT (2026-09-04).
 *
 * Found by the browser QA pass: a double-click on "Create Invoice" fired two
 * POSTs and minted two identical draft invoices — each of which would mint its
 * own ZATCA ICV on approval, from an ordinary slip, with no way to delete an
 * issued invoice. The button-disable alone cannot fix it (a retry or a slow
 * network reproduces it), so the durable guard is server-side: one key per
 * dialog open, a partial unique index, and a create that resolves the
 * collision to the FIRST invoice.
 *
 * Asserted: two creates with the SAME key produce ONE invoice (same id); a
 * DIFFERENT key produces a second; and a create with NO key still works (the
 * conversion/recurring/seed paths do not send one).
 *
 * Needs a real database; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[invoice-idempotency] no real DATABASE_URL — skipping.");

const SLUG = "inv-idempotency";
const EMAIL = "inv-idem@test.local";
const DATE = "2026-07-22";

describeMaybe("invoice create is idempotent under a repeated key", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.33" }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Idem Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'Idem Co','1010707070','399999999955503') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','Idem User',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(
        `INSERT INTO customers (organization_id, name, name_ar, tax_number) VALUES ($1,'Idem Client','عميل','300000000000003') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  const body = (key?: string) => ({
    ...(key ? { idempotencyKey: key } : {}),
    date: DATE,
    customerId,
    items: [{ description: "Widget", quantity: 1, unitPrice: 100, vatRate: 15 }],
  });

  it("🔴 two creates with the SAME key produce ONE invoice", async () => {
    const key = "11111111-1111-1111-1111-111111111111";
    const a = await inTenant(() => invoicesService.create(body(key), userId));
    const b = await inTenant(() => invoicesService.create(body(key), userId));
    expect(b.id).toBe(a.id); // the replay resolves to the first
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM invoices WHERE organization_id = $1 AND idempotency_key = $2`,
      [orgId, key],
    );
    expect(rows[0].n).toBe(1);
  });

  it("a DIFFERENT key produces a distinct invoice", async () => {
    const a = await inTenant(() => invoicesService.create(body("22222222-2222-2222-2222-222222222222"), userId));
    const b = await inTenant(() => invoicesService.create(body("33333333-3333-3333-3333-333333333333"), userId));
    expect(b.id).not.toBe(a.id);
  });

  it("a create with NO key still works — conversion/recurring/seed paths", async () => {
    const a = await inTenant(() => invoicesService.create(body(), userId));
    expect(a.id).toBeGreaterThan(0);
  });
});
