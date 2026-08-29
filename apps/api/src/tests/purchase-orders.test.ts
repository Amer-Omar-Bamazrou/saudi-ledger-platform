/**
 * Purchase orders + PO → bill matching (M21.3).
 *
 * The quotation mirror is proven the same way (zero movement at every status,
 * conversion through the existing path, freeze rule, dated events). What is
 * NEW here, and what most of this file is about, is MATCHING:
 *
 *   - the bill is the truth: a supplier's different price is RECORDED, not
 *     refused and not silently reconciled;
 *   - over-billing is refused BY DEFAULT but possible with an explicit
 *     override, because refusing outright would mean refusing to record a real
 *     liability;
 *   - a line the supplier billed that was never ordered is allowed;
 *   - 🔴 and nothing anywhere claims to know what was DELIVERED.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { purchaseOrdersService } from "../services/purchaseOrders.service";
import { purchaseOrderConversionService } from "../services/purchaseOrderConversion.service";
import { billsService } from "../services/bills.service";
import { reportsService } from "../services/reports.service";
import { billingState } from "../services/purchaseOrders.presenter";
import { PERMISSION_MATRIX } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[purchase-orders] no real DATABASE_URL — skipping.");
}

const DATE = "2026-10-12";
const FROM = "2026-10-01";
const TO = "2026-10-31";

describeMaybe("Purchase orders (M21.3)", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let vendorId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.66" }, fn),
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
      await pool.query(`DELETE FROM purchase_order_conversion_items WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM purchase_order_conversions WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM journal_entries WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM purchase_order_items WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM purchase_orders WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM bill_items WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM bill_payments WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = $1)`, [orgId]);
      await pool.query(`DELETE FROM bills WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM vendors WHERE organization_id = $1`, [orgId]);
    }
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email = 'po@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name = 'PO Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'po-test'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('PO Org','po-test') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'PO Co','1010101013','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('po@test.local','Buyer',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (
      await pool.query(
        `INSERT INTO vendors (organization_id, name, name_ar, tax_number) VALUES ($1,'Parts Supplier','مورد','300000000000003') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function financialSnapshot() {
    const [is, bs, tb, ap] = await Promise.all([
      reportsService.incomeStatement(FROM, TO),
      reportsService.balanceSheet(),
      reportsService.trialBalance(FROM, TO),
      reportsService.apAging(),
    ]);
    return {
      expenses: is.totalExpenses,
      netIncome: is.netIncome,
      liabilities: bs.liabilities.total,
      accountsPayable: bs.liabilities.accountsPayable,
      trialDebits: tb.totalDebit,
      trialCredits: tb.totalCredit,
      apTotal: ap.total,
    };
  }

  let baseline: Awaited<ReturnType<typeof financialSnapshot>>;
  let poId = 0;
  let lineAId = 0;

  async function expectZeroEverywhere(label: string) {
    const now = await inTenant(financialSnapshot);
    for (const key of Object.keys(baseline) as (keyof typeof baseline)[]) {
      expect(now[key], `${label}: ${key} must not have moved`).toBe(baseline[key]);
    }
  }

  /** 20 bolts at 25, plus 5 brackets at 40. */
  async function makeApprovedPo() {
    const po = await inTenant(() =>
      purchaseOrdersService.create(
        {
          date: DATE,
          vendorId,
          items: [
            { description: "Bolts", quantity: 20, unitPrice: 25, vatRate: 15 },
            { description: "Brackets", quantity: 5, unitPrice: 40, vatRate: 15 },
          ],
        },
        userId,
      ),
    );
    return inTenant(() => purchaseOrdersService.approve(po.id, userId));
  }

  it("captures the baseline before any purchase order exists", async () => {
    baseline = await inTenant(financialSnapshot);
    for (const [key, value] of Object.entries(baseline)) {
      expect(typeof value, `baseline.${key} must be a number — an undefined field asserts nothing`).toBe("number");
    }
  });

  it("creates a PO as a DRAFT with a server-allocated number", async () => {
    const po = await inTenant(() =>
      purchaseOrdersService.create(
        {
          date: DATE,
          vendorId,
          status: "approved", // must be ignored
          items: [
            { description: "Bolts", quantity: 20, unitPrice: 25, vatRate: 15 },
            { description: "Brackets", quantity: 5, unitPrice: 40, vatRate: 15 },
          ],
        },
        userId,
      ),
    );
    poId = po.id;
    lineAId = po.items![0].id;
    expect(po.status).toBe("draft");
    expect(po.orderNumber).toBe("PO-2026-0001");
    expect(po.subtotal).toBe(700);
    expect(po.vatAmount).toBe(105);
    expect(po.billingState).toBe("open");
    expect(po.items![0].unbilledQuantity).toBe(20);
  });

  it("🔴 a PO moves nothing at DRAFT, SUBMITTED or APPROVED", async () => {
    await expectZeroEverywhere("draft");
    await inTenant(() => purchaseOrdersService.submit(poId, userId));
    await expectZeroEverywhere("submitted");
    const approved = await inTenant(() => purchaseOrdersService.approve(poId, userId));
    expect(approved.status).toBe("approved");
    await expectZeroEverywhere("approved");
  });

  it("PARTIAL billing: the supplier bills 8 of 20 bolts at the agreed price", async () => {
    const { bill } = await inTenant(() =>
      purchaseOrderConversionService.convert(
        poId,
        { lines: [{ purchaseOrderItemId: lineAId, quantity: 8 }], date: DATE },
        userId,
      ),
    );
    expect(bill.subtotal).toBe(200);
    expect(bill.vatAmount).toBe(30);
    // 🔴 DRAFTS ONLY, inherited from the M21.2 correction — this caller is an
    // org admin holding every grant.
    expect(bill.status).toBe("draft");

    const po = await inTenant(() => purchaseOrdersService.getById(poId));
    expect(po.billingState).toBe("partially_billed");
    expect(po.items![0].billedQuantity).toBe(8);
    expect(po.items![0].unbilledQuantity).toBe(12);
    // No price variance: they billed what was agreed.
    expect(po.items![0].priceVariances).toEqual([]);
  });

  it("🔴 THE BILL IS THE TRUTH: a different supplier price is RECORDED, not refused", async () => {
    // Ordered at 25; the supplier bills the remaining 12 at 27.50.
    const { bill } = await inTenant(() =>
      purchaseOrderConversionService.convert(
        poId,
        { lines: [{ purchaseOrderItemId: lineAId, quantity: 12, unitPrice: 27.5 }], date: "2026-10-20" },
        userId,
      ),
    );
    // The BILL carries the supplier's price — 12 × 27.50 = 330.
    expect(bill.subtotal).toBe(330);

    const po = await inTenant(() => purchaseOrdersService.getById(poId));
    // The ORDER still says what we ordered. Neither document was rewritten.
    expect(po.items![0].unitPrice).toBe(25);
    // And the difference is a recorded fact, with both figures and its date.
    expect(po.items![0].priceVariances).toEqual([
      { orderedUnitPrice: 25, billedUnitPrice: 27.5, quantity: 12, billedOn: "2026-10-20", difference: 2.5 },
    ]);
  });

  it("🔴 OVER-BILLING is refused by default…", async () => {
    // Bolts are fully billed (8 + 12 = 20); brackets have 5 left.
    await expect(
      inTenant(() =>
        purchaseOrderConversionService.convert(
          poId,
          { lines: [{ purchaseOrderItemId: lineAId, quantity: 1 }], date: DATE },
          userId,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("…but POSSIBLE with an explicit override — a real liability is never unrecordable", async () => {
    const { bill } = await inTenant(() =>
      purchaseOrderConversionService.convert(
        poId,
        { lines: [{ purchaseOrderItemId: lineAId, quantity: 1 }], date: DATE, allowOverBilling: true },
        userId,
      ),
    );
    expect(bill.subtotal).toBe(25);
    const po = await inTenant(() => purchaseOrdersService.getById(poId));
    expect(po.items![0].billedQuantity).toBe(21);
    // Over-billed, so nothing is un-billed — never a negative remainder.
    expect(po.items![0].unbilledQuantity).toBe(0);
  });

  it("a line the supplier billed that was NEVER ORDERED is allowed (freight, surcharges)", async () => {
    const po = await makeApprovedPo();
    const { bill } = await inTenant(() =>
      purchaseOrderConversionService.convert(
        po.id,
        {
          lines: [{ purchaseOrderItemId: po.items![0].id, quantity: 20 }],
          unorderedLines: [{ description: "Freight", quantity: 1, unitPrice: 75, vatRate: 15 }],
          date: DATE,
        },
        userId,
      ),
    );
    // 20 × 25 = 500, plus 75 freight.
    expect(bill.subtotal).toBe(575);
    // The freight has no conversion row, which is exactly what makes it
    // identifiable as unordered — the order's own lines are untouched by it.
    const after = await inTenant(() => purchaseOrdersService.getById(po.id));
    expect(after.items![0].billedQuantity).toBe(20);
    expect(after.items![1].billedQuantity).toBe(0);
  });

  it("the dated billing history survives multiple events (B4's lesson)", async () => {
    const history = await inTenant(() => purchaseOrderConversionService.history(poId));
    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history.map((h) => h.billedOn)).toContain("2026-10-20");
    expect(new Set(history.map((h) => h.billId)).size).toBe(history.length);
  });

  it("🔴 THE FREEZE RULE: a billed line cannot have its ordered price changed", async () => {
    const po = await inTenant(() => purchaseOrdersService.getById(poId));
    const items = po.items!.map((i) => ({
      id: i.id,
      description: i.description,
      quantity: i.quantity,
      unitPrice: i.id === lineAId ? 99 : i.unitPrice,
      vatRate: i.vatRate,
    }));
    await expect(inTenant(() => purchaseOrdersService.update(poId, { items }))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("a billed order cannot be deleted", async () => {
    await expect(inTenant(() => purchaseOrdersService.deleteDraft(poId))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("🔴 CANCELLED, not declined — we withdraw an order; the supplier does not refuse it", async () => {
    const po = await makeApprovedPo();
    const cancelled = await inTenant(() => purchaseOrdersService.setOutcome(po.id, "cancelled"));
    expect(cancelled.outcome).toBe("cancelled");
    // The vocabulary is enforced at the DB too — 'declined' is not a value a
    // purchase order can hold.
    await expect(
      pool.query(`UPDATE purchase_orders SET outcome = 'declined' WHERE id = $1`, [po.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      inTenant(() => purchaseOrderConversionService.convert(po.id, {}, userId)),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("only an APPROVED, live order can be billed", async () => {
    const draft = await inTenant(() =>
      purchaseOrdersService.create({ date: DATE, vendorId, items: [{ description: "x", quantity: 1, unitPrice: 5 }] }, userId),
    );
    await expect(
      inTenant(() => purchaseOrderConversionService.convert(draft.id, {}, userId)),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects lines that are not lines (named 400s, never a DB 500)", async () => {
    const bad = (items: unknown) => inTenant(() => purchaseOrdersService.create({ date: DATE, vendorId, items }, userId));
    await expect(bad([])).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad([{ description: "x", quantity: 0, unitPrice: 5 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad([{ description: "x", quantity: "abc", unitPrice: 5 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad([{ description: " ", quantity: 1, unitPrice: 5 }])).rejects.toMatchObject({ statusCode: 400 });
  });

  /**
   * 🔴 THE ONE-WRITER PROOF, the AP mirror of the quotation side.
   *
   * The produced bill must be indistinguishable from a hand-typed one: convert
   * → draft (moves nothing) → approve through the ORDINARY bill path → the
   * same AP movement a manual bill of the same value produces.
   */
  it("🔴 a converted bill posts through the SAME path as a hand-typed one", async () => {
    const po = await inTenant(() =>
      purchaseOrdersService.create(
        { date: DATE, vendorId, items: [{ description: "Same shape", quantity: 4, unitPrice: 100, vatRate: 15 }] },
        userId,
      ),
    );
    const approved = await inTenant(() => purchaseOrdersService.approve(po.id, userId));
    const apBefore = (await inTenant(() => reportsService.balanceSheet())).liabilities.accountsPayable;

    const { bill } = await inTenant(() =>
      purchaseOrderConversionService.convert(approved.id, { date: DATE }, userId),
    );
    expect(bill.status, "conversion is drafts-only").toBe("draft");
    expect(
      (await inTenant(() => reportsService.balanceSheet())).liabilities.accountsPayable,
      "a DRAFT bill must not move AP",
    ).toBe(apBefore);

    await inTenant(() => billsService.approve(bill.id, {}, userId));
    const apAfterConverted = (await inTenant(() => reportsService.balanceSheet())).liabilities.accountsPayable;
    const movedByConversion = Math.round((apAfterConverted - apBefore) * 100) / 100;

    await inTenant(() =>
      billsService.create(
        {
          billNumber: "BILL-HANDTYPED-1",
          date: DATE,
          vendorId,
          items: [{ description: "Same shape", quantity: 4, unitPrice: 100, vatRate: 15 }],
        },
        userId,
      ),
    );
    const handTyped = (await inTenant(() => billsService.list({}))).find((b: any) => b.billNumber === "BILL-HANDTYPED-1");
    expect(handTyped, "the hand-typed bill must exist for this comparison to mean anything").toBeTruthy();
    await inTenant(() => billsService.approve(handTyped!.id, {}, userId));
    const apAfterManual = (await inTenant(() => reportsService.balanceSheet())).liabilities.accountsPayable;
    const movedByManual = Math.round((apAfterManual - apAfterConverted) * 100) / 100;

    expect(movedByConversion, "an approved converted bill must move AP").toBe(460);
    expect(movedByManual, "and a hand-typed one must move it identically").toBe(movedByConversion);
  });
});

/** Pure derivation — no database. */
describe("billingState (the derived axis)", () => {
  it("no lines is OPEN", () => {
    expect(billingState([])).toBe("open");
  });
  it("nothing billed → open", () => {
    expect(billingState([{ quantity: 10, billedQuantity: 0 }])).toBe("open");
  });
  it("some billed → partially_billed", () => {
    expect(billingState([{ quantity: 10, billedQuantity: 4 }])).toBe("partially_billed");
  });
  it("all billed → fully_billed", () => {
    expect(billingState([{ quantity: 10, billedQuantity: 10 }])).toBe("fully_billed");
  });
  it("🔴 OVER-billed is fully_billed, never 'partially'", () => {
    // Over-billing is allowed with an override, and reporting the result as
    // "partially billed" would be plainly wrong.
    expect(billingState([{ quantity: 10, billedQuantity: 11 }])).toBe("fully_billed");
  });
  it("a fractional remainder keeps it partial rather than rounding it closed", () => {
    expect(billingState([{ quantity: 10, billedQuantity: 9.9 }])).toBe("partially_billed");
  });
});

describe("purchase_orders permission grants", () => {
  const grants = PERMISSION_MATRIX.filter((p) => p.resource === "purchase_orders");
  const rolesFor = (action: string) => grants.filter((g) => g.action === action).map((g) => g.role).sort();

  it("exists at all — an unseeded resource 403s on every route", () => {
    expect(grants.length).toBeGreaterThan(0);
  });
  it("🔴 a bookkeeper may draft but NOT issue an order to a supplier", () => {
    expect(rolesFor("create")).toContain("bookkeeper");
    expect(rolesFor("approve")).toEqual(["accountant", "admin"]);
    expect(rolesFor("approve")).not.toContain("bookkeeper");
  });
  it("only an admin may delete", () => {
    expect(rolesFor("delete")).toEqual(["admin"]);
  });
});
