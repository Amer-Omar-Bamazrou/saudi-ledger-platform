/**
 * THE PAYLOAD-SHAPE CLASS — a well-formed request that asks for nothing, and a
 * 201 that says it happened.
 *
 * ── 🔴 THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────
 * `POST /invoices` with `items: []` returned **201**. Not a malformed request —
 * a perfectly well-formed one, with an empty array. And because an approver's
 * own invoice is auto-approved, what came back was ISSUED: `status: "sent"`,
 * an ICV consumed, a position taken in the ZATCA hash chain, a QR minted, for
 * SAR 0.00.
 *
 * None of it recoverable. An issued invoice cannot be deleted (draft only), and
 * `PATCH /invoices/:id` had no caller to add the lines afterwards even if it
 * could. So the product could mint permanently-zero tax invoices, one per
 * click, each one taking a slot in a chain that legally must not have gaps.
 *
 * 🔴 **THE ROOT IS SHARPER THAN "BAD INPUT GOT THROUGH".** The request was
 * well-formed; the *validation existed on the wrong schema*. `CreateQuotationInput`
 * and `CreatePurchaseOrderInput` declare `minItems: 1` in the OpenAPI spec and
 * their services enforce it by hand — and those two documents touch NO ledger.
 * `CreateInvoiceInput` declares no `items` at all, and nothing enforced it —
 * for the one document that consumes an ICV. **The guard was written where the
 * consequence was smallest.**
 *
 * 🔴 **AND EVERY TEST WE HAD BYPASSED THE LAYER THAT HAD THE BUG.** The invoice
 * suites call `invoicesService.create` with hand-built objects that always
 * carry items, because a test author writing a fixture writes a realistic one.
 * Nothing exercised the shape a CLIENT actually sends — and `Invoices.tsx`
 * hardcoded `items: []` on every create, so the shape the client sent was the
 * one nothing tested. Verified below the layer that matters: the same family as
 * the SDK differential that proved only that we matched a stale writer.
 *
 * This file therefore tests the SHAPE, at the service boundary the routes call,
 * across every create path — because the defect was never in one path, it was
 * in which paths had been thought about.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3133";
process.env.SESSION_SECRET ??= "payload-shape-boundary-secret-0123456789";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "@workspace/db";
import { createApproved } from "./helpers/createApproved";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "payload-shape-boundary";

async function inTenant<T>(orgId: string, companyId: string, userId: number, fn: () => Promise<T>): Promise<T> {
  const { beginTenantConnection } = await import("@workspace/db");
  const { auditContext } = await import("../lib/auditContext");
  const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
  try {
    const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  }
}

/**
 * The source-level half: the CLIENT must not send the shape that caused this.
 * It costs nothing and it is the assertion that would have caught the original.
 */
describe("no create form ships an empty line array", () => {
  it("🔴 the invoice form does not hardcode `items: []`", () => {
    // Comments stripped: the fix's own note quotes the literal it removed, and
    // matching prose rather than code is how an assertion starts lying.
    const src = readFileSync(join(repoRoot, "apps", "web", "src", "pages", "Invoices.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // The literal that made every invoice from this page SAR 0.00 and issued.
    expect(src).not.toMatch(/items:\s*\[\s*\]/);
  });
});

describeMaybe("the payload-shape boundary, across every create path", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let vendorId = 0;

  const wipe = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM quotations WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM purchase_order_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM purchase_orders WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_number_counters WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    const { rows } = await pool.query(`SELECT user_id FROM organization_memberships WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE organization_id IN ${org}`);
    for (const r of rows) await pool.query(`DELETE FROM users WHERE id = $1`, [r.user_id]);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await wipe();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status)
         VALUES ('Payload Shape Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number)
         VALUES ($1,'Shape Co','1010101019','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ($1,'x','Shaper') RETURNING id`, [
        `payload-shape-${Date.now()}@example.test`,
      ])
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`,
      [orgId, userId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Shape Customer') RETURNING id`, [orgId])
    ).rows[0].id;
    vendorId = (
      await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Shape Vendor') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(wipe);

  it("🔴 an INVOICE with an empty line array is REFUSED — it would be issued at zero, irreversibly", async () => {
    const { invoicesService } = await import("../services/invoices.service");
    await expect(
      inTenant(orgId, companyId, userId, () =>
        createApproved(invoicesService, { date: "2026-08-01", customerId, items: [] } as never, userId as never),
      ),
    ).rejects.toMatchObject({ statusCode: 400, payload: { code: "invoice_has_no_lines" } });

    // And nothing was minted: no invoice, and no ICV consumed.
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM invoices WHERE organization_id = $1`,
      [orgId],
    );
    expect(rows[0].n).toBe(0);
    const counter = await pool.query(
      `SELECT count(*)::int n FROM invoice_number_counters WHERE organization_id = $1`,
      [orgId],
    );
    expect(counter.rows[0].n, "a refused invoice must not consume a number").toBe(0);
  });

  it("🔴 an invoice with a real line still works (anti-vacuity — the rule refuses the empty case, not the feature)", async () => {
    const { invoicesService } = await import("../services/invoices.service");
    const inv = await inTenant(orgId, companyId, userId, () =>
      invoicesService.create(
        { date: "2026-08-01", customerId, items: [{ description: "Work", quantity: 1, unitPrice: 100, vatRate: 15 }] } as never,
        userId as never,),
    );
    expect((inv as { total: number }).total).toBe(115);
  });

  it("🔴 a BILL that records nothing is refused — but a header-only bill (the capture path) still works", async () => {
    const { billsService } = await import("../services/bills.service");
    await expect(
      inTenant(orgId, companyId, userId, () =>
        billsService.create({ date: "2026-08-01", vendorId, billNumber: "SHAPE-0", items: [] } as never, userId),
      ),
    ).rejects.toMatchObject({ statusCode: 400, payload: { code: "bill_records_nothing" } });

    // 🔴 The deliberate asymmetry: OCR reads header amounts off a photograph and
    // the line detail is not ours to invent, so a no-items bill WITH a total is
    // legitimate and must keep working.
    const bill = await inTenant(orgId, companyId, userId, () =>
      billsService.create(
        { date: "2026-08-01", vendorId, billNumber: "SHAPE-1", items: [], subtotal: 100, vatAmount: 15, total: 115 } as never,
        userId,
      ),
    );
    expect((bill as { total: number }).total).toBe(115);
  });

  it("quotations and purchase orders already refused this — the guard was written where the consequence was SMALLEST", async () => {
    const { quotationsService } = await import("../services/quotations.service");
    const { purchaseOrdersService } = await import("../services/purchaseOrders.service");
    await expect(
      inTenant(orgId, companyId, userId, () =>
        quotationsService.create({ date: "2026-08-01", customerId, items: [] } as never, userId),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      inTenant(orgId, companyId, userId, () =>
        purchaseOrdersService.create({ date: "2026-08-01", vendorId, items: [] } as never, userId),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
