/**
 * PARTY CONTRACT CONFORMANCE — customers, vendors and the bills list, validated
 * against the generated Zod schemas on REAL ROWS (contract milestone, batch 2).
 *
 * Same instrument as `report-contract-conformance`: every response must parse
 * under its generated `<Op>Response` schema; every case asserts its rows are
 * PRESENT before validating so nothing is proven against `[]`; and the write
 * bodies are parsed with the generated `<Op>Body` schema exactly as the
 * controllers do, so what this test sends is what a real client can send.
 *
 * ── 🔴 WHAT THE CONTRACT MADE VISIBLE, PINNED HERE ─────────────────────────
 * 1. `creditLimit` was a NUMBER from list/detail and a STRING from create/
 *    update (the raw row). One presentation now, asserted on the create path.
 * 2. The UI sent `creditLimit: ""` for "no limit"; `Number("")` is 0, so the
 *    old guard passed and "" was stored — read back as a limit of 0.00. The
 *    generated body refuses "" (asserted), and "" on a nullable text field is
 *    stored as NULL, not as an empty string that reads as a value (asserted).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import {
  ListCustomersResponse,
  GetCustomerResponse,
  CreateCustomerBody,
  CreateCustomerResponse,
  UpdateCustomerBody,
  UpdateCustomerResponse,
  ListVendorsResponse,
  GetVendorResponse,
  CreateVendorBody,
  CreateVendorResponse,
  UpdateVendorBody,
  UpdateVendorResponse,
  MatchVendorBody,
  MatchVendorResponse,
  ListBillsResponse,
  ListInvoicesResponse,
  ListQuotationsResponse,
  ListPurchaseOrdersResponse,
} from "@workspace/api-zod";
import { auditContext } from "../lib/auditContext";
import { customersService } from "../services/customers.service";
import { vendorsService } from "../services/vendors.service";
import { billsService } from "../services/bills.service";
import { invoicesService } from "../services/invoices.service";
import { quotationsService } from "../services/quotations.service";
import { purchaseOrdersService } from "../services/purchaseOrders.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[party-contract-conformance] no real DATABASE_URL — skipping.");

const SLUG = "party-contract";
const EMAIL = "party-contract@test.local";

type ParseResult = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };
function issues(r: ParseResult): string {
  if (r.success || !r.error) return "";
  return r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
}

describeMaybe("party contract conformance — customers, vendors, bills list on real rows", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let vendorId = 0;

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
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const U = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    for (const t of ["quotation_items", "quotations", "purchase_order_items", "purchase_orders", "invoice_items", "invoices", "bill_items", "bills", "customers", "vendors"]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${O}`);
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Party Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'Party Co','1010101034') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','PC',' ','viewer',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);

    // One party with every nullable field NULL and one fully filled — both
    // shapes must conform, because both exist in real data.
    customerId = (
      await pool.query(
        `INSERT INTO customers (organization_id, name, name_ar, tax_number, cr_number, phone, email, address, city, credit_limit, payment_terms_days)
         VALUES ($1,'Filled Customer','عميل','310000000000003','1010000001','+966500000000','c@x.sa','1 St','Riyadh','5000.00','45') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Bare Customer')`, [orgId]);
    vendorId = (
      await pool.query(
        `INSERT INTO vendors (organization_id, name, name_ar, tax_number, cr_number, phone, email, address, city, iban, payment_terms_days)
         VALUES ($1,'Filled Vendor','مورد','311111111111113','1010000002','+966511111111','v@x.sa','2 St','Jeddah','SA0380000000608010167519','30') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Bare Vendor Trading')`, [orgId]);

    // Issued documents so the balances are non-zero (and a draft that must not count).
    await pool.query(
      `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,$3,'PC-INV-1','invoice','2026-04-01','2026-04-30',1000,150,1150,1150,'paid'),
              ($1,$2,$3,'PC-INV-2','invoice','2026-05-01','2026-05-31',2000,300,2300,0,'sent'),
              ($1,$2,$3,'PC-INV-3','invoice','2026-06-01','2026-06-30',300,45,345,0,'draft')`,
      [orgId, companyId, customerId],
    );
    await pool.query(
      `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,$3,'PC-BILL-1','2026-05-05','2026-06-05',400,60,460,0,'received'),
              ($1,$2,$3,'PC-BILL-2','2026-06-05',NULL,100,15,115,115,'paid')`,
      [orgId, companyId, vendorId],
    );
    // The detail pages list a customer's quotations and a vendor's purchase
    // orders through the SAME generated types, so those lists are proven here.
    await pool.query(
      `INSERT INTO quotations (organization_id, company_id, customer_id, quotation_number, date, valid_until, subtotal, vat_amount, total, status)
       VALUES ($1,$2,$3,'PC-QUO-1','2026-08-01','2999-01-01',2000,300,2300,'submitted')`,
      [orgId, companyId, customerId],
    );
    await pool.query(
      `INSERT INTO purchase_orders (organization_id, company_id, vendor_id, order_number, date, subtotal, vat_amount, total, status)
       VALUES ($1,$2,$3,'PC-PO-1','2026-08-02',1500,225,1725,'approved')`,
      [orgId, companyId, vendorId],
    );
  });

  afterAll(cleanup);

  function conforms(schema: { safeParse: (v: unknown) => ParseResult }, value: unknown, label: string) {
    // 🔴 Validate what goes over the WIRE, not the in-memory object: `res.json`
    // serialises Dates to ISO strings and drops undefined keys, and the contract
    // describes the response a client receives. (A required key that is
    // undefined is MISSING after the round-trip, so it still fails.)
    const r = schema.safeParse(JSON.parse(JSON.stringify(value)));
    expect(r.success, `${label} does not conform to its generated schema:\n${issues(r)}`).toBe(true);
  }

  it("GET /customers — a page with balances and set-wide totals", async () => {
    const out = await inTenant(() => customersService.list({ limit: 50, offset: 0 }));
    expect(out.items.length).toBe(2);
    expect(out.totals.totalBilled).toBeGreaterThan(0);
    conforms(ListCustomersResponse, out, "listCustomers");
  });

  it("GET /customers/{id} — detail with the issued-invoice count", async () => {
    const out = await inTenant(() => customersService.getById(customerId));
    expect(out.invoiceCount).toBe(2); // the draft does not count
    expect(out.creditLimit).toBe(5000);
    conforms(GetCustomerResponse, out, "getCustomer");
  });

  it("POST /customers — the body is the generated one; the response is the same shape every read path returns", async () => {
    // 🔴 "" for creditLimit is REFUSED at the body — it used to pass as 0.
    expect(CreateCustomerBody.safeParse({ name: "X", creditLimit: "" }).success).toBe(false);
    expect(CreateCustomerBody.safeParse({ name: "" }).success).toBe(false);

    const body = CreateCustomerBody.parse({ name: "Created Customer", nameAr: "", taxNumber: "", city: "Dammam", creditLimit: 250 });
    const out = await inTenant(() => customersService.create(body));
    conforms(CreateCustomerResponse, out, "createCustomer");
    expect(out.creditLimit).toBe(250); // a NUMBER, as on list/detail — not the raw text
    expect(out.taxNumber).toBeNull(); // "" stored as NULL, not as an empty string
    expect(out.nameAr).not.toBe(""); // NOT NULL column: the default applied

    const upd = UpdateCustomerBody.parse({ creditLimit: null, phone: "" });
    const out2 = await inTenant(() => customersService.update(out.id, upd));
    conforms(UpdateCustomerResponse, out2, "updateCustomer");
    expect(out2.creditLimit).toBeNull();
    expect(out2.phone).toBeNull();
  });

  it("GET /vendors — a page with balances and set-wide totals", async () => {
    const out = await inTenant(() => vendorsService.list({ limit: 50, offset: 0 }));
    expect(out.items.length).toBe(2);
    expect(out.totals.totalBilled).toBeGreaterThan(0);
    conforms(ListVendorsResponse, out, "listVendors");
  });

  it("GET /vendors/{id} — detail with the bill count", async () => {
    const out = await inTenant(() => vendorsService.getById(vendorId));
    expect(out.billCount).toBe(2);
    conforms(GetVendorResponse, out, "getVendor");
  });

  it("POST /vendors and PATCH /vendors/{id}", async () => {
    const out = await inTenant(() => vendorsService.create(CreateVendorBody.parse({ name: "Created Vendor", iban: "" })));
    conforms(CreateVendorResponse, out, "createVendor");
    expect(out.created).toBe(true);
    expect(out.iban).toBeNull();
    const out2 = await inTenant(() => vendorsService.update(out.id, UpdateVendorBody.parse({ city: "Khobar" })));
    conforms(UpdateVendorResponse, out2, "updateVendor");
  });

  it("POST /vendors/match — exact, fuzzy and none all conform", async () => {
    const exact = await inTenant(() => vendorsService.match(MatchVendorBody.parse({ vatNumber: "311111111111113" })));
    expect(exact.matchType).toBe("exact");
    conforms(MatchVendorResponse, exact, "matchVendor(exact)");
    const fuzzy = await inTenant(() => vendorsService.match(MatchVendorBody.parse({ vendorName: "Bare Vendor" })));
    expect(fuzzy.matchType).toBe("fuzzy");
    expect(fuzzy.suggestions.length).toBeGreaterThan(0);
    conforms(MatchVendorResponse, fuzzy, "matchVendor(fuzzy)");
    const none = await inTenant(() => vendorsService.match(MatchVendorBody.parse({ vendorName: "zzzzzz" })));
    expect(none.matchType).toBe("none");
    conforms(MatchVendorResponse, none, "matchVendor(none)");
  });

  it("GET /bills — a page with a NULL due date and set-wide totals", async () => {
    const out = await inTenant(() => billsService.list({ vendorId, limit: 50, offset: 0 }));
    expect(out.items.length).toBe(2);
    conforms(ListBillsResponse, out, "listBills");
  });

  /**
   * 🔴 The three document lists the detail pages read. `Invoice` had been in
   * the spec since #106 and was WRONG: five fields the presenter sends were
   * missing (documentType — the credit-note marker — originalInvoiceId,
   * noteReason, icv, zatcaUuid) and one it never sends (createdAt) was
   * required. Quotation and PurchaseOrder declared NO required list, so every
   * field was optional. None of it had ever been checked against a response.
   */
  it("GET /invoices — including a credit-note-capable shape", async () => {
    const out = await inTenant(() => invoicesService.list({ customerId, limit: 50, offset: 0 }));
    expect(out.items.length).toBe(3);
    expect(out.items.every((i) => typeof i.documentType === "string")).toBe(true);
    conforms(ListInvoicesResponse, out, "listInvoices");
  });

  it("GET /quotations", async () => {
    const out = await inTenant(() => quotationsService.list({ customerId, limit: 50, offset: 0 }));
    expect(out.items.length).toBe(1);
    conforms(ListQuotationsResponse, out, "listQuotations");
  });

  it("GET /purchase-orders", async () => {
    const out = await inTenant(() => purchaseOrdersService.list({ vendorId, limit: 50, offset: 0 }));
    expect(out.items.length).toBe(1);
    conforms(ListPurchaseOrdersResponse, out, "listPurchaseOrders");
  });

  it("🔴 the instrument is not vacuous — a wrong shape FAILS", async () => {
    const out = await inTenant(() => customersService.list({ limit: 50, offset: 0 }));
    const broken = { ...out, items: out.items.map(({ balance, ...r }) => ({ ...r, outstanding: balance })) };
    expect(ListCustomersResponse.safeParse(broken).success).toBe(false);
    expect(GetVendorResponse.safeParse({ id: 1, name: "v" }).success).toBe(false);
  });
});
