/**
 * 🔴 Phase 18 audit (2026-11-11), finding A30 — a draft edit with no header field to change is not a 500.
 *
 * `invoicesService.update` and `billsService.update` end in `updateDraft(id, { ...values, ...totals })` — the SQL
 * UPDATE that applies the edit only while the document is still a draft (PR B, R1). When the body names no editable
 * header field and no lines, the set is EMPTY and drizzle throws "No values to set": a 500. That reached three
 * requests: an empty PATCH, a PATCH whose only field the contract dropped (found by A14's red run), and — the one
 * that matters — an invoice PATCH carrying only `prepayments`, which the contract documents as replacing the
 * adjustment selection: an edit the spec offers and the server could not make.
 *
 * Presence, absence, movement: an empty edit answers the draft unchanged; a prepayments-only edit is applied; an
 * empty edit of an ISSUED invoice is still refused 409 (the no-op path keeps the draft-only condition). DB-backed.
 */
process.env.PORT ??= "3394";
process.env.SESSION_SECRET ??= "phase18-audit-a30-empty-draft-edit-001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { releaseIssuedInvoicesForTeardown } from "./helpers/issuedInvoiceFixtures";
import { invoicesRepository } from "../repositories/invoices.repository";
import { billsRepository } from "../repositories/bills.repository";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA30EmptyDraftEditPw1!";

describeMaybe("Phase 18 audit A30 — a draft edit with no header field to change", () => {
  const h = g04Harness("auda30");
  let orgId = "", companyId = "", adminId = 0, customerId = 0, vendorId = 0;

  const make = async (path: string, body: unknown) => {
    const r = await h.api("admin", "POST", path, body);
    expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body as { id: number; total: number | string; notes?: string | null };
  };
  const items = [{ description: "Service", quantity: 1, unitPrice: 1_000, vatRate: 15 }];

  beforeAll(async () => {
    await releaseIssuedInvoicesForTeardown(`organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'auda30-%')`);
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit A30 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'A30 Buyer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'A30 Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await releaseIssuedInvoicesForTeardown(`organization_id = $1`, [orgId]);
    await h.cleanup();
  });

  it("🔴 an empty invoice draft edit answers the draft unchanged, not a 500", async () => {
    const inv = await make("/invoices", { date: "2026-06-01", customerId, notes: "A30 keep", items });
    const r = await h.api("admin", "PATCH", `/invoices/${inv.id}`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id: inv.id, notes: "A30 keep", status: "draft" });
  });

  it("🔴 an invoice draft edit carrying only `prepayments` is applied (the contract documents it)", async () => {
    const inv = await make("/invoices", { date: "2026-06-01", customerId, items });
    const r = await h.api("admin", "PATCH", `/invoices/${inv.id}`, { prepayments: [] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id: inv.id, status: "draft" });
  });

  it("🔴 an empty bill draft edit answers the draft unchanged, not a 500", async () => {
    const bill = await make("/bills", { vendorId, billNumber: `A30-B-${Date.now()}`, supplierDocumentKind: "tax_invoice", vendorReference: "A30-SUP-1", date: "2026-06-01", subtotal: 1000, vatAmount: 150, total: 1150, items: [], notes: "A30 bill keep" });
    const r = await h.api("admin", "PATCH", `/bills/${bill.id}`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id: bill.id, status: "draft" });
  });

  it("🔴 at the seam: the no-op answers NOTHING for a document that is no longer a draft (the condition the race relies on)", async () => {
    const inv = await make("/invoices", { date: "2026-06-01", customerId, items });
    expect((await h.api("admin", "POST", `/invoices/${inv.id}/approve`, {})).status).toBe(200);
    const invRows = await h.inTenant(orgId, companyId, adminId, () => invoicesRepository.updateDraft(inv.id, {}));
    expect(invRows, "an issued invoice is not a draft").toEqual([]);
    const bill = await make("/bills", { vendorId, billNumber: `A30-B2-${Date.now()}`, supplierDocumentKind: "tax_invoice", vendorReference: "A30-SUP-2", date: "2026-06-01", subtotal: 1000, vatAmount: 150, total: 1150, items: [] });
    expect((await h.api("admin", "POST", `/bills/${bill.id}/approve`, {})).status).toBe(200);
    const billRows = await h.inTenant(orgId, companyId, adminId, () => billsRepository.updateDraft(bill.id, {}));
    expect(billRows, "an approved bill is not a draft").toEqual([]);
  });

  it("absence: an empty edit of an ISSUED invoice is still refused 409 — the no-op keeps the draft-only condition", async () => {
    const inv = await make("/invoices", { date: "2026-06-01", customerId, items });
    const approved = await h.api("admin", "POST", `/invoices/${inv.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const r = await h.api("admin", "PATCH", `/invoices/${inv.id}`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(409);
  });
});
