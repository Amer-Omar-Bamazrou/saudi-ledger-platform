/**
 * 🔴 Phase 18 G1 (owner decision 6) — confirming a supplier's VAT shown below
 * 15 % decides that it is claimed as shown: a review decision about a tax
 * claim, so it is an APPROVER'S act (rbac APPROVE_ROUTE, the `acknowledge`
 * reasoning). A bookkeeper who records the bill cannot confirm its figures;
 * an approver can. Presence and absence on the same bill.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3245";
process.env.SESSION_SECRET ??= "phase18-vat-g1-confirm-authority-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18VatG1AuthorityPw1!";

describeMaybe("Phase 18 G1 — who may confirm a supplier's VAT figures (decision 6)", () => {
  const h = g04Harness("p18vatg1auth");
  let vendorId = 0;

  beforeAll(async () => {
    await h.cleanup();
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "VAT G1 Authority Co", "310123456789013");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'G1 Auth Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    expect(await h.login("bookkeeper", h.email("bookkeeper"), PW), "login bookkeeper").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a bookkeeper's confirmation is refused (403) and leaves the bill held; an approver's is accepted", async () => {
    const b = await h.api("bookkeeper", "POST", "/bills", { vendorId, vendorReference: "AUTH-1", supplierDocumentKind: "tax_invoice", date: "2026-09-10", subtotal: 1000, vatAmount: 100, total: 1100, items: [] });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const byBookkeeper = await h.api("bookkeeper", "POST", `/bills/${b.body.id}/vat-figures-confirmation`, { note: "Delivery note DN-1" });
    const after = await h.api("admin", "GET", `/bills/${b.body.id}`);
    expect([byBookkeeper.status, after.body.vatEvidence.status, after.body.vatFiguresConfirmation]).toEqual([403, "awaiting_evidence", null]);
    const byApprover = await h.api("admin", "POST", `/bills/${b.body.id}/vat-figures-confirmation`, { note: "Delivery note DN-1" });
    expect([byApprover.status, byApprover.body.vatEvidence?.status], JSON.stringify(byApprover.body)).toEqual([200, "evidenced"]);
  });
});
