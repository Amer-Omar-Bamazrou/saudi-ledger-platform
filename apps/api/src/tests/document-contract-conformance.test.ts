/**
 * DOCUMENT CONTRACT CONFORMANCE — invoices and bills, detail and WRITE paths,
 * validated against the generated Zod schemas on REAL ROWS (contract batch 3).
 *
 * Same instrument as the report and party conformance suites: every response
 * must parse under its generated `<Op>Response` schema after a JSON
 * round-trip (what a client receives); every body is parsed with the
 * generated `<Op>Body` schema exactly as the controllers do; rows are
 * asserted PRESENT before any schema is checked.
 *
 * ── 🔴 THE APPROVAL RESPONSE IS A LEGAL ARTIFACT (owner, 2026-09-01) ────────
 * An approved invoice's response carries the ICV, the hash-chain link, the
 * ZATCA UUID and the QR. Those are asserted PRESENT on a real approval through
 * the product's own path — `invoicesService.approve` → the approval engine →
 * `issueInvoice` — never assumed from the presenter. Two approvals prove the
 * chain: the second ICV is the first plus one and its `previousHash` is the
 * first invoice's hash. A draft, by contrast, must carry NONE of them: drafts
 * consume no ICV (§4).
 *
 * ── WHAT THIS BATCH MADE VISIBLE, PINNED HERE ──────────────────────────────
 * 1. `PATCH /invoices/{id}` had ignored `items` since M10 while the edit dialog
 *    sent them on every save — a 200 and unchanged lines (the inert-write
 *    shape). Draft line replacement is now real and asserted: the total moves.
 * 2. `GET /invoices` had no date range; the invoice summary report fetched
 *    200 rows and filtered client-side. `date_from`/`date_to` are asserted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import {
  CreateInvoiceBody,
  CreateInvoiceResponse,
  GetInvoiceResponse,
  UpdateInvoiceBody,
  UpdateInvoiceResponse,
  ApproveInvoiceResponse,
  PayInvoiceBody,
  PayInvoiceResponse,
  ListInvoicePaymentsResponse,
  ListInvoicesResponse,
  CreateBillBody,
  CreateBillResponse,
  GetBillResponse,
  UpdateBillBody,
  UpdateBillResponse,
  PostBillResponse,
  PayBillBody,
  PayBillResponse,
  ListBillPaymentsResponse,
} from "@workspace/api-zod";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[document-contract-conformance] no real DATABASE_URL — skipping.");

const SLUG = "document-contract";
const EMAIL = "document-contract@test.local";
const DATE = "2026-06-15";

type ParseResult = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };
function issues(r: ParseResult): string {
  if (r.success || !r.error) return "";
  return r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
}

describeMaybe("document contract conformance — invoices & bills, detail and write paths, on real rows", () => {
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
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${O})`);
    await pool.query(`DELETE FROM bill_payments WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${O})`);
    for (const t of ["journal_entry_lines", "journal_entries", "einvoice_documents", "invoice_items", "invoices", "bill_items", "bills", "document_numbers", "customers", "vendors"]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${O}`).catch((e: Error) => {
        if (!/does not exist/.test(e.message)) throw e;
      });
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Document Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'Document Co','1010101042','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','DC',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar, tax_number) VALUES ($1,'Doc Customer','عميل','310000000000003') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Doc Vendor') RETURNING id`, [orgId])).rows[0].id;
  });

  afterAll(cleanup);

  function conforms(schema: { safeParse: (v: unknown) => ParseResult }, value: unknown, label: string) {
    const r = schema.safeParse(JSON.parse(JSON.stringify(value)));
    expect(r.success, `${label} does not conform to its generated schema:\n${issues(r)}`).toBe(true);
  }

  const lines = (unitPrice: number) => [{ description: "Consulting", quantity: 1, unitPrice, vatRate: 15 }];

  let draftId = 0;
  let firstIssued: { icv: number | null; invoiceHash: string | null } = { icv: null, invoiceHash: null };

  it("POST /invoices — a DRAFT with its lines, and NO ICV, hash, UUID or QR", async () => {
    // Both layers refuse a line-less invoice: the generated body, and the service.
    expect(CreateInvoiceBody.safeParse({ date: DATE, customerId, items: [] }).success).toBe(false);
    await expect(inTenant(() => invoicesService.create({ date: DATE, customerId, items: [] }, userId))).rejects.toMatchObject({
      payload: { code: "invoice_has_no_lines" },
    });

    const body = CreateInvoiceBody.parse({ date: DATE, customerId, items: lines(200) });
    const out = await inTenant(() => invoicesService.create(body, userId));
    draftId = out.id;
    expect(out.status).toBe("draft");
    expect(out.total).toBe(230);
    expect(out.icv).toBeNull();
    expect(out.invoiceHash).toBeNull();
    expect(out.zatcaUuid).toBeNull();
    expect(out.qrCode).toBeNull();
    conforms(CreateInvoiceResponse, out, "createInvoice");
  });

  it("GET /invoices/{id} — with its lines", async () => {
    const out = await inTenant(() => invoicesService.getById(draftId));
    expect(out.items?.length).toBe(1);
    conforms(GetInvoiceResponse, out, "getInvoice");
  });

  it("PATCH /invoices/{id} — replacing the lines MOVES the total (it used to answer 200 and change nothing)", async () => {
    const body = UpdateInvoiceBody.parse({ notes: "edited", items: [{ description: "Consulting", quantity: 2, unitPrice: 300, vatRate: 15 }] });
    const out = await inTenant(() => invoicesService.update(draftId, body));
    expect(out.total).toBe(690);
    expect(out.items?.length).toBe(1);
    expect(out.items?.[0].quantity).toBe(2);
    conforms(UpdateInvoiceResponse, out, "updateInvoice");
    // And the read path agrees.
    const again = await inTenant(() => invoicesService.getById(draftId));
    expect(again.total).toBe(690);
    expect(again.items?.length).toBe(1);
    // An empty replacement is refused at both layers.
    expect(UpdateInvoiceBody.safeParse({ items: [] }).success).toBe(false);
    await expect(inTenant(() => invoicesService.update(draftId, { items: [] }))).rejects.toMatchObject({ payload: { code: "invoice_has_no_lines" } });
  });

  it("🔴 POST /invoices/{id}/approve — the legal artifact: ICV, hash, previous hash, UUID and QR are PRESENT on a real approval", async () => {
    const out = await inTenant(() => invoicesService.approve(draftId, userId));
    expect(out.status).toBe("sent");
    expect(typeof out.icv).toBe("number");
    expect(out.invoiceHash).toBeTruthy();
    expect(out.previousHash).toBeTruthy(); // GENESIS for the first
    expect(out.zatcaUuid).toBeTruthy();
    expect(out.qrCode).toBeTruthy();
    conforms(ApproveInvoiceResponse, out, "approveInvoice");
    firstIssued = { icv: out.icv, invoiceHash: out.invoiceHash };
  });

  it("🔴 a second approval CHAINS: icv + 1, previousHash = the first hash", async () => {
    const draft = await inTenant(() => invoicesService.create(CreateInvoiceBody.parse({ date: DATE, customerId, items: lines(100) }), userId));
    const out = await inTenant(() => invoicesService.approve(draft.id, userId));
    expect(out.icv).toBe((firstIssued.icv ?? 0) + 1);
    expect(out.previousHash).toBe(firstIssued.invoiceHash);
    conforms(ApproveInvoiceResponse, out, "approveInvoice(second)");
  });

  it("POST /invoices/{id}/pay and GET /invoices/{id}/payments", async () => {
    expect(PayInvoiceBody.safeParse({ amount: 0 }).success).toBe(false);
    const paid = await inTenant(() => invoicesService.pay(draftId, PayInvoiceBody.parse({ amount: 690, paidAt: "2026-06-20" }), userId));
    expect(paid.status).toBe("paid");
    conforms(PayInvoiceResponse, paid, "payInvoice");
    const history = await inTenant(() => invoicesService.payments(draftId));
    expect(history.length).toBe(1);
    expect(history[0].backfilled).toBe(false);
    conforms(ListInvoicePaymentsResponse, history, "listInvoicePayments");
  });

  it("GET /invoices — date_from/date_to narrow the set on the SERVER", async () => {
    await inTenant(() => invoicesService.create(CreateInvoiceBody.parse({ date: "2026-01-10", customerId, items: lines(50) }), userId));
    const all = await inTenant(() => invoicesService.list({ limit: 50, offset: 0 }));
    const june = await inTenant(() => invoicesService.list({ dateFrom: "2026-06-01", dateTo: "2026-06-30", limit: 50, offset: 0 }));
    expect(all.page.total).toBe(3);
    expect(june.page.total).toBe(2);
    expect(june.items.every((i) => i.date >= "2026-06-01" && i.date <= "2026-06-30")).toBe(true);
    conforms(ListInvoicesResponse, june, "listInvoices(date range)");
  });

  it("DELETE /invoices/{id} — drafts only", async () => {
    const draft = await inTenant(() => invoicesService.create(CreateInvoiceBody.parse({ date: DATE, customerId, items: lines(10) }), userId));
    await inTenant(() => invoicesService.deleteDraft(draft.id));
    await expect(inTenant(() => invoicesService.getById(draft.id))).rejects.toMatchObject({ statusCode: 404 });
    await expect(inTenant(() => invoicesService.deleteDraft(draftId))).rejects.toMatchObject({ statusCode: 409 });
  });

  let billId = 0;

  it("POST /bills — a draft from header totals (the form's `items: []` path)", async () => {
    expect(CreateBillBody.safeParse({ date: DATE }).success).toBe(true); // shape-valid; the SERVICE refuses a bill recording nothing
    await expect(inTenant(() => billsService.create({ date: DATE, vendorId, items: [] }, userId))).rejects.toMatchObject({ payload: { code: "bill_records_nothing" } });
    const body = CreateBillBody.parse({ date: DATE, vendorId, subtotal: 400, vatAmount: 60, total: 460, items: [] });
    const out = await inTenant(() => billsService.create(body, userId));
    billId = out.id;
    expect(out.status).toBe("draft");
    expect(out.total).toBe(460);
    conforms(CreateBillResponse, out, "createBill");
  });

  it("GET /bills/{id} and PATCH /bills/{id}", async () => {
    const got = await inTenant(() => billsService.getById(billId));
    conforms(GetBillResponse, got, "getBill");
    const upd = await inTenant(() => billsService.update(billId, UpdateBillBody.parse({ vendorReference: "SUP-77", notes: "edited" })));
    expect(upd.vendorReference).toBe("SUP-77");
    conforms(UpdateBillResponse, upd, "updateBill");
  });

  it("POST /bills/{id}/post — approved and posted", async () => {
    const out = await inTenant(() => billsService.post(billId, {}, userId));
    expect(out.status).toBe("received");
    conforms(PostBillResponse, out, "postBill");
  });

  it("POST /bills/{id}/pay and GET /bills/{id}/payments", async () => {
    expect(PayBillBody.safeParse({ amount: -1 }).success).toBe(false);
    const paid = await inTenant(() => billsService.pay(billId, PayBillBody.parse({ amount: 460, paidAt: "2026-06-25" }), userId));
    expect(paid.status).toBe("paid");
    conforms(PayBillResponse, paid, "payBill");
    const history = await inTenant(() => billsService.payments(billId));
    expect(history.length).toBe(1);
    conforms(ListBillPaymentsResponse, history, "listBillPayments");
  });

  it("🔴 the instrument is not vacuous — a wrong shape FAILS", async () => {
    const out = await inTenant(() => invoicesService.getById(draftId));
    const broken = { ...out, icv: String(out.icv), items: undefined };
    expect(ApproveInvoiceResponse.safeParse(JSON.parse(JSON.stringify(broken))).success).toBe(false);
    expect(ListInvoicePaymentsResponse.safeParse([{ id: 1, amount: "10", paidAt: "2026-01-01" }]).success).toBe(false);
  });
});
