/**
 * 🔴 Phase 18 final round (owner, 2026-11-04), walk finding 18, register §11.141: the API half of the read-only invoice
 * screen, `GET /invoices/:id/issue-view`: the seller and the QR image.
 *
 * An issued invoice's seller is the identity stamped at issue, never the live company (G31), so a later rename must not move
 * it, while a draft follows the live company and says it is not stamped. Isolation: present, absent, and moving.
 * The response is parsed against the generated schema, so the spec entry is a contract and not a claim.
 */
process.env.PORT ??= "3221";
process.env.SESSION_SECRET ??= "z8-invoice-issue-view-00000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { GetInvoiceIssueViewResponse } from "@workspace/api-zod";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Z8InvoiceIssueViewPw1!";
const VAT_A = "300000000000003";
const VAT_B = "311111111111113";

describeMaybe("GET /invoices/:id/issue-view", () => {
  const h = g04Harness("z8view");
  let companyA = "";
  let issuedA = 0;
  let draftA = 0;
  let issuedB = 0;

  const invoice = async (who: string, number: string) => {
    const customer = await h.api(who, "POST", "/customers", { name: `Z8 Customer ${number}` });
    expect(customer.status, JSON.stringify(customer.body)).toBe(201);
    const made = await h.api(who, "POST", "/invoices", { invoiceNumber: number, date: "2026-10-05", dueDate: "2026-10-31", customerId: customer.body.id, items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.id as number;
  };
  const issue = async (who: string, id: number) => {
    const r = await h.api(who, "POST", `/invoices/${id}/approve`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const view = async (who: string, id: number) => {
    const r = await h.api(who, "GET", `/invoices/${id}/issue-view`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return GetInvoiceIssueViewResponse.parse(r.body);
  };

  beforeAll(async () => {
    await h.cleanup();
    const orgA = await h.mkOrg("a");
    const orgB = await h.mkOrg("b");
    companyA = await h.mkCompany(orgA, "Z8 Seller A", VAT_A);
    await h.mkCompany(orgB, "Z8 Seller B", VAT_B);
    await h.mkUser("a", PW, orgA, "admin");
    await h.mkUser("aviewer", PW, orgA, "viewer");
    await h.mkUser("b", PW, orgB, "admin");
    await h.start();
    for (const who of ["a", "aviewer", "b"]) expect(await h.login(who, h.email(who), PW)).toBe(200);
    for (const who of ["a", "b"]) {
      const bank = await h.api(who, "POST", "/bank-accounts", { name: `Z8 Bank ${who}`, bankName: "SNB", currency: "SAR", isDefault: true });
      expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    }
    issuedA = await invoice("a", "Z8-A-ISSUED");
    await issue("a", issuedA);
    draftA = await invoice("a", "Z8-A-DRAFT");
    issuedB = await invoice("b", "Z8-B-ISSUED");
    await issue("b", issuedB);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("🔴 an issued invoice: the stamped seller and a real QR image", async () => {
    const v = await view("a", issuedA);
    expect([v.sellerName, v.sellerVatNumber, v.sellerStamped]).toEqual(["Z8 Seller A", VAT_A, true]);
    expect(v.qrImage).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]{100,}$/);
  });

  it("🔴 a draft: no QR, and the live company, marked as not stamped", async () => {
    const v = await view("a", draftA);
    expect([v.sellerName, v.sellerStamped, v.qrImage]).toEqual(["Z8 Seller A", false, null]);
  });

  it("🔴 renaming the company moves the draft's seller and never the issued invoice's", async () => {
    await pool.query(`UPDATE companies SET name = 'Z8 Seller A Renamed' WHERE id = $1`, [companyA]);
    try {
      expect((await view("a", draftA)).sellerName, "the draft follows the company").toBe("Z8 Seller A Renamed");
      expect((await view("a", issuedA)).sellerName, "the issued invoice keeps its stamp").toBe("Z8 Seller A");
    } finally {
      await pool.query(`UPDATE companies SET name = 'Z8 Seller A' WHERE id = $1`, [companyA]);
    }
  });

  it("🔴 isolation: each tenant reads its own, and another tenant's invoice is a 404", async () => {
    expect((await view("b", issuedB)).sellerName, "B sees its own seller").toBe("Z8 Seller B");
    const crossed = await h.api("b", "GET", `/invoices/${issuedA}/issue-view`);
    expect(crossed.status, JSON.stringify(crossed.body)).toBe(404);
    expect(JSON.stringify(crossed.body)).not.toContain("Z8 Seller A");
  });

  it("every role that reads invoices reads this, and a bad id is refused", async () => {
    expect((await view("aviewer", issuedA)).sellerStamped).toBe(true);
    expect((await h.api("a", "GET", "/invoices/abc/issue-view")).status).toBe(400);
    expect((await h.api("a", "GET", "/invoices/2147483647/issue-view")).status).toBe(404);
  });
});
