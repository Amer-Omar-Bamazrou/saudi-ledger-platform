/**
 * Quotation → invoice conversion (M21.2).
 *
 * What this has to prove, in order of how badly it would hurt to get wrong:
 *
 * 1. Conversion goes through the EXISTING invoice path. The produced invoice
 *    must be indistinguishable from a hand-typed one — same statuses, same GL
 *    posting on approval. If conversion ever grew its own posting path, the
 *    dashboard/P&L divergence of meta-finding #9 would come back.
 * 2. Partial conversion by QUANTITY, with the remainder still open, and the
 *    conversion history DATED per event (B4's lesson: a running total loses
 *    the first instalment's date).
 * 3. Over-conversion refused — you cannot invoice more than was quoted.
 * 4. The freeze rule: a converted line cannot be re-priced or removed, while
 *    untouched lines stay editable.
 * 5. The quotation itself STILL moves nothing. Only the invoice does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { quotationsService } from "../services/quotations.service";
import { quotationConversionService } from "../services/quotationConversion.service";
import { invoicesService } from "../services/invoices.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[quotation-conversion] no real DATABASE_URL — skipping.");
}

const DATE = "2026-09-10";

describeMaybe("Quotation → invoice conversion (M21.2)", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.55" }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    if (orgId) {
      await pool.query(`DELETE FROM quotation_conversion_items WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM quotation_conversions WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM journal_entries WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM quotation_items WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM quotations WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM invoice_items WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = $1)`, [orgId]);
      await pool.query(`DELETE FROM invoices WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM customers WHERE organization_id = $1`, [orgId]);
    }
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email = 'quo-convert@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name = 'CONV Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'conv-test'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('CONV Org','conv-test') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'CONV Co','1010101012','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('quo-convert@test.local','Converter',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'Converting Customer','عميل') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  /** An approved quotation: 10 × 100 standard-rated, 4 × 50 zero-rated. */
  async function makeApprovedQuotation() {
    const quo = await inTenant(() =>
      quotationsService.create(
        {
          date: DATE,
          customerId,
          items: [
            { description: "Widgets", quantity: 10, unitPrice: 100, vatRate: 15 },
            { description: "Zero-rated service", quantity: 4, unitPrice: 50, vatRate: 0 },
          ],
        },
        userId,
      ),
    );
    return inTenant(() => quotationsService.approve(quo.id, userId));
  }

  let quotationId = 0;
  let firstItemId = 0;
  let secondItemId = 0;

  it("sets up an approved quotation, still open", async () => {
    const quo = await makeApprovedQuotation();
    quotationId = quo.id;
    firstItemId = quo.items![0].id!;
    secondItemId = quo.items![1].id!;
    expect(quo.conversionState).toBe("open");
    expect(quo.items![0].remainingQuantity).toBe(10);
  });

  it("PARTIAL conversion by quantity: 4 of 10 widgets become an invoice", async () => {
    const { invoice, conversion } = await inTenant(() =>
      quotationConversionService.convert(
        quotationId,
        { lines: [{ quotationItemId: firstItemId, quantity: 4 }], date: DATE, convertedOn: "2026-09-08" },
        userId,
        { autoApprove: false },
      ),
    );

    // 🔴 The price is FROZEN at the quoted 100, and only 4 units are invoiced.
    expect(invoice.subtotal).toBe(400);
    expect(invoice.vatAmount).toBe(60);
    expect(invoice.total).toBe(460);
    // A conversion produces a DRAFT for a caller without approve rights.
    expect(invoice.status).toBe("draft");
    expect(conversion.convertedOn).toBe("2026-09-08");
  });

  it("the remainder STAYS OPEN and the state says partially_converted", async () => {
    const quo = await inTenant(() => quotationsService.getById(quotationId));
    expect(quo.conversionState).toBe("partially_converted");
    expect(quo.items![0].convertedQuantity).toBe(4);
    expect(quo.items![0].remainingQuantity).toBe(6);
    // The untouched line is untouched.
    expect(quo.items![1].convertedQuantity).toBe(0);
    expect(quo.items![1].remainingQuantity).toBe(4);
    // 🔴 The quotation is NOT closed by a partial conversion, and no outcome
    // was invented on the tenant's behalf.
    expect(quo.outcome).toBeNull();
  });

  it("🔴 OVER-CONVERSION is refused — 6 remain, 7 is a 409", async () => {
    await expect(
      inTenant(() =>
        quotationConversionService.convert(quotationId, { lines: [{ quotationItemId: firstItemId, quantity: 7 }] }, userId),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a SECOND conversion is allowed, and both dates survive (B4's lesson)", async () => {
    await inTenant(() =>
      quotationConversionService.convert(
        quotationId,
        { lines: [{ quotationItemId: firstItemId, quantity: 6 }], date: DATE, convertedOn: "2026-09-20" },
        userId,
      ),
    );
    const history = await inTenant(() => quotationConversionService.history(quotationId));
    expect(history).toHaveLength(2);
    // 🔴 THE POINT: two events, two DISTINCT dates. A running `converted_quantity`
    // column would have kept only the second one.
    expect(history.map((h) => h.convertedOn)).toEqual(["2026-09-08", "2026-09-20"]);
    expect(new Set(history.map((h) => h.invoiceId)).size, "each conversion made its own invoice").toBe(2);
  });

  it("the fully-converted line reports zero remaining; the quotation is still partial", async () => {
    const quo = await inTenant(() => quotationsService.getById(quotationId));
    expect(quo.items![0].convertedQuantity).toBe(10);
    expect(quo.items![0].remainingQuantity).toBe(0);
    // Line 2 is untouched, so the QUOTATION is not converted.
    expect(quo.conversionState).toBe("partially_converted");
  });

  it("🔴 THE FREEZE RULE: a converted line cannot be re-priced", async () => {
    const quo = await inTenant(() => quotationsService.getById(quotationId));
    const items = quo.items!.map((i) => ({
      id: i.id,
      description: i.description,
      quantity: i.quantity,
      unitPrice: i.id === firstItemId ? 999 : i.unitPrice,
      vatRate: i.vatRate,
    }));
    await expect(inTenant(() => quotationsService.update(quotationId, { items }))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("🔴 THE FREEZE RULE: a converted line cannot be removed", async () => {
    const quo = await inTenant(() => quotationsService.getById(quotationId));
    const items = quo.items!
      .filter((i) => i.id !== firstItemId)
      .map((i) => ({ id: i.id, description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, vatRate: i.vatRate }));
    await expect(inTenant(() => quotationsService.update(quotationId, { items }))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("an UNTOUCHED line is still editable, and its id survives the edit", async () => {
    const before = await inTenant(() => quotationsService.getById(quotationId));
    const items = before.items!.map((i) => ({
      id: i.id,
      description: i.description,
      quantity: i.quantity,
      unitPrice: i.id === secondItemId ? 55 : i.unitPrice,
      vatRate: i.vatRate,
    }));
    const after = await inTenant(() => quotationsService.update(quotationId, { items }));
    const edited = after.items!.find((i) => i.id === secondItemId)!;
    expect(edited.unitPrice).toBe(55);
    // 🔴 Ids must be STABLE. If the edit path replaced lines wholesale, the
    // converted line's id would change and the conversion history would point
    // at a row that no longer exists.
    expect(after.items!.find((i) => i.id === firstItemId)?.convertedQuantity).toBe(10);
  });

  it("converting the rest with no `lines` takes exactly what is outstanding", async () => {
    await inTenant(() => quotationConversionService.convert(quotationId, { date: DATE }, userId));
    const quo = await inTenant(() => quotationsService.getById(quotationId));
    expect(quo.conversionState).toBe("converted");
    expect(quo.items!.every((i) => i.remainingQuantity === 0)).toBe(true);
  });

  it("converting a fully-converted quotation is refused rather than making an empty invoice", async () => {
    await expect(
      inTenant(() => quotationConversionService.convert(quotationId, {}, userId)),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a converted quotation cannot be DELETED — it is the record of what was agreed", async () => {
    await expect(inTenant(() => quotationsService.remove(quotationId))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("only an APPROVED, live quotation converts", async () => {
    const draft = await inTenant(() =>
      quotationsService.create({ date: DATE, customerId, items: [{ description: "d", quantity: 1, unitPrice: 10 }] }, userId),
    );
    await expect(inTenant(() => quotationConversionService.convert(draft.id, {}, userId))).rejects.toMatchObject({
      statusCode: 409,
    });

    const declined = await makeApprovedQuotation();
    await inTenant(() => quotationsService.setOutcome(declined.id, "declined", userId));
    await expect(inTenant(() => quotationConversionService.convert(declined.id, {}, userId))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("🔴 an EXPIRED quotation still converts — expiry warns, it never blocks", async () => {
    const quo = await inTenant(() =>
      quotationsService.create(
        { date: "2026-01-05", validUntil: "2026-01-31", customerId, items: [{ description: "lapsed", quantity: 1, unitPrice: 200 }] },
        userId,
      ),
    );
    const approved = await inTenant(() => quotationsService.approve(quo.id, userId));
    expect(approved.expired, "fixture must actually be lapsed for this to prove anything").toBe(true);
    const { invoice } = await inTenant(() => quotationConversionService.convert(quo.id, { date: DATE }, userId));
    expect(invoice.total).toBe(230);
  });

  it("a line's discount is SCALED to the converted proportion", async () => {
    // 100 SAR discount on 10 units; converting 4 must carry 40, not 100.
    const quo = await inTenant(() =>
      quotationsService.create(
        { date: DATE, customerId, items: [{ description: "Discounted", quantity: 10, unitPrice: 100, vatRate: 15, discount: 100 }] },
        userId,
      ),
    );
    const approved = await inTenant(() => quotationsService.approve(quo.id, userId));
    const { invoice } = await inTenant(() =>
      quotationConversionService.convert(
        approved.id,
        { lines: [{ quotationItemId: approved.items![0].id!, quantity: 4 }], date: DATE },
        userId,
      ),
    );
    // 4 × 100 = 400, less the scaled 40 = 360 base; VAT 54.
    expect(invoice.subtotal).toBe(360);
    expect(invoice.vatAmount).toBe(54);
  });

  /**
   * 🔴 THE ONE-WRITER PROOF.
   *
   * Conversion must produce an invoice indistinguishable from a hand-typed
   * one. The check is behavioural, not structural: approve the converted
   * invoice and prove it posts to the GL exactly as a manually created invoice
   * of the same value does. If conversion ever grew a private posting path,
   * these two numbers would stop agreeing.
   */
  it("🔴 a converted invoice posts through the SAME path as a hand-typed one", async () => {
    const quo = await inTenant(() =>
      quotationsService.create(
        { date: DATE, customerId, items: [{ description: "Same shape", quantity: 2, unitPrice: 250, vatRate: 15 }] },
        userId,
      ),
    );
    const approved = await inTenant(() => quotationsService.approve(quo.id, userId));

    const arBefore = (await inTenant(() => reportsService.balanceSheet())).assets.accountsReceivable;

    const { invoice } = await inTenant(() =>
      quotationConversionService.convert(approved.id, { date: DATE }, userId, { autoApprove: true }),
    );
    expect(invoice.status).not.toBe("draft");
    const arAfterConverted = (await inTenant(() => reportsService.balanceSheet())).assets.accountsReceivable;
    const movedByConversion = Math.round((arAfterConverted - arBefore) * 100) / 100;

    // The same invoice, typed by hand.
    await inTenant(() =>
      invoicesService.create(
        {
          invoiceNumber: "INV-HANDTYPED-1",
          date: DATE,
          customerId,
          items: [{ description: "Same shape", quantity: 2, unitPrice: 250, vatRate: 15 }],
        },
        userId,
        { autoApprove: true },
      ),
    );
    const arAfterManual = (await inTenant(() => reportsService.balanceSheet())).assets.accountsReceivable;
    const movedByManual = Math.round((arAfterManual - arAfterConverted) * 100) / 100;

    expect(movedByConversion, "a converted invoice must move AR").toBe(575);
    expect(movedByManual, "and a hand-typed one must move it identically").toBe(movedByConversion);
  });

  /**
   * The quotation side still moves nothing. Conversion changes what the
   * INVOICE does; it must not give the quotation a ledger effect of its own,
   * or the same value would be counted twice.
   */
  it("🔴 the quotation itself STILL moves nothing after being converted", async () => {
    const quo = await makeApprovedQuotation();
    const before = await inTenant(async () => {
      const bs = await reportsService.balanceSheet();
      const is = await reportsService.incomeStatement("2026-09-01", "2026-09-30");
      return { ar: bs.assets.accountsReceivable, revenue: is.totalRevenue };
    });

    // Convert to a DRAFT invoice — a draft moves nothing either, so if any
    // figure moves here it can only have come from the quotation side.
    await inTenant(() => quotationConversionService.convert(quo.id, { date: DATE }, userId, { autoApprove: false }));

    const after = await inTenant(async () => {
      const bs = await reportsService.balanceSheet();
      const is = await reportsService.incomeStatement("2026-09-01", "2026-09-30");
      return { ar: bs.assets.accountsReceivable, revenue: is.totalRevenue };
    });
    expect(after.ar, "converting to a DRAFT must move no AR").toBe(before.ar);
    expect(after.revenue, "converting to a DRAFT must move no revenue").toBe(before.revenue);
  });
});
