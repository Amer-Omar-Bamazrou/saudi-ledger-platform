/**
 * Quotations (M21.1) — the ZERO-MOVEMENT proof, the approval state machine,
 * numbering, and the guards.
 *
 * 🔴 The centrepiece is `expectZeroEverywhere`. The owner's Q-4 constraint is
 * that a quotation touches NOTHING until it is converted, and that constraint
 * is worth exactly as much as the test that proves it. So this asserts through
 * the REAL report services — income statement, balance sheet, trial balance,
 * AR aging, VAT return, cash flow — at every status a quotation can hold.
 *
 * Two deliberate choices about HOW it asserts:
 *
 * 1. It asserts the PROPERTY, not a fixture number: the figures are captured
 *    before the quotation exists and compared after each transition. A test
 *    that hardcoded 0.00 would pass just as happily on a broken org where
 *    everything is zero anyway.
 * 2. It proves the reports are LOAD-BEARING by also creating a real invoice on
 *    the same org and showing the SAME assertions then move. Otherwise
 *    "nothing moved" could mean "nothing was ever measured" — the vacuous-probe
 *    failure this codebase has hit before (flaw #8's Zakat zeros).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { quotationsService } from "../services/quotations.service";
import { invoicesService } from "../services/invoices.service";
import { reportsService } from "../services/reports.service";
import { conversionState } from "../services/quotations.presenter";
import { PERMISSION_MATRIX } from "@workspace/db";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[quotations] no real DATABASE_URL — skipping.");
}

const DATE = "2026-06-15";
const FROM = "2026-06-01";
const TO = "2026-06-30";

describeMaybe("Quotations (M21.1)", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.44" }, fn),
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
    await pool.query(`DELETE FROM users WHERE email = 'quotations@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name = 'QUO Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'quo-test'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('QUO Org','quo-test') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'QUO Co','1010101011','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('quotations@test.local','Quoter',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'Quoted Customer','عميل') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  /** Every figure a quotation must never touch. Captured, then compared. */
  async function financialSnapshot() {
    const [is, bs, tb, ar, vat, cf] = await Promise.all([
      reportsService.incomeStatement(FROM, TO),
      reportsService.balanceSheet(),
      reportsService.trialBalance(FROM, TO),
      reportsService.arAging(),
      reportsService.vatReturn("2026-06", "2026-06"),
      reportsService.cashFlow(FROM, TO),
    ]);
    return {
      revenue: is.totalRevenue,
      expenses: is.totalExpenses,
      netIncome: is.netIncome,
      assets: bs.assets.total,
      liabilities: bs.liabilities.total,
      accountsReceivable: bs.assets.accountsReceivable,
      trialDebits: tb.totalDebit,
      trialCredits: tb.totalCredit,
      arTotal: ar.total,
      vatOutput: vat.salesSection.box8_totalOutputVat,
      cashNet: cf.netChange,
    };
  }

  let baseline: Awaited<ReturnType<typeof financialSnapshot>>;
  let quotationId = 0;

  async function expectZeroEverywhere(label: string) {
    const now = await inTenant(financialSnapshot);
    for (const key of Object.keys(baseline) as (keyof typeof baseline)[]) {
      expect(now[key], `${label}: ${key} must not have moved`).toBe(baseline[key]);
    }
  }

  it("captures the baseline BEFORE any quotation exists", async () => {
    baseline = await inTenant(financialSnapshot);
    // 🔴 Every field must be a real number. Three of these were initially
    // mistyped (`totalDebits` for `totalDebit`, `netCashFlow` for `netChange`)
    // and so were `undefined` — which made those comparisons `undefined ===
    // undefined`, i.e. three assertions that could never fail. Typecheck caught
    // it; this catches the next one, including any field a report renames.
    for (const [key, value] of Object.entries(baseline)) {
      expect(typeof value, `baseline.${key} must be a number, not ${typeof value} — a snapshot field that reads undefined asserts nothing`).toBe("number");
    }
  });

  it("creates a quotation as a DRAFT with a server-allocated number", async () => {
    const quo = await inTenant(() =>
      quotationsService.create(
        {
          date: DATE,
          validUntil: "2026-07-15",
          customerId,
          // 🔴 A caller-supplied status must be ignored, exactly as it is for
          // invoices — the H1 audit finding was a client PATCHing itself into
          // an issued state.
          status: "approved",
          items: [
            { description: "Consulting", quantity: 10, unitPrice: 100, vatRate: 15 },
            { description: "Zero-rated export", quantity: 2, unitPrice: 50, vatRate: 0 },
          ],
        },
        userId,
      ),
    );
    quotationId = quo.id;
    expect(quo.status).toBe("draft");
    expect(quo.quotationNumber).toBe("QUO-2026-0001");
    // Header = Σ rounded lines, the invoice rule: 1000 + 100 = 1100 base,
    // VAT only on the standard line = 150.
    expect(quo.subtotal).toBe(1100);
    expect(quo.vatAmount).toBe(150);
    expect(quo.total).toBe(1250);
    // 0% is left NULL rather than guessed — Z/E/O are different tax facts.
    expect(quo.items?.[0].taxCategoryCode).toBe("S");
    expect(quo.items?.[1].taxCategoryCode).toBeNull();
    expect(quo.conversionState).toBe("open");
  });

  it("🔴 DRAFT moves nothing, anywhere", async () => {
    await expectZeroEverywhere("draft");
  });

  it("numbers increment per company and per year", async () => {
    const second = await inTenant(() =>
      quotationsService.create({ date: DATE, customerId, items: [{ description: "x", quantity: 1, unitPrice: 5 }] }, userId),
    );
    expect(second.quotationNumber).toBe("QUO-2026-0002");
    // A different year restarts the series rather than continuing it.
    const nextYear = await inTenant(() =>
      quotationsService.create({ date: "2027-01-04", customerId, items: [{ description: "y", quantity: 1, unitPrice: 5 }] }, userId),
    );
    expect(nextYear.quotationNumber).toBe("QUO-2027-0001");
  });

  it("SUBMIT (draft → submitted): still nothing, and edits are locked", async () => {
    const quo = await inTenant(() => quotationsService.submit(quotationId, userId));
    expect(quo.status).toBe("submitted");
    await expectZeroEverywhere("submitted");
    await expect(inTenant(() => quotationsService.update(quotationId, { notes: "nope" }))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("SEND-BACK (submitted → draft) carries the reviewer's note", async () => {
    const quo = await inTenant(() => quotationsService.sendBack(quotationId, userId, "Drop the price"));
    expect(quo.status).toBe("draft");
    expect(quo.reviewNote).toBe("Drop the price");
    await expectZeroEverywhere("sent-back");
  });

  it("APPROVE: the quotation may go to the customer — and STILL moves nothing", async () => {
    const quo = await inTenant(() => quotationsService.approve(quotationId, userId));
    expect(quo.status).toBe("approved");
    expect(quo.reviewNote).toBeNull();
    // 🔴 This is the assertion the whole milestone rests on. Every other
    // approvable entity posts to the GL here. This one must not.
    await expectZeroEverywhere("approved");
  });

  it("an APPROVED quotation is still editable — it is an offer, not a legal document", async () => {
    const quo = await inTenant(() =>
      quotationsService.update(quotationId, {
        items: [{ description: "Consulting (renegotiated)", quantity: 10, unitPrice: 90, vatRate: 15 }],
      }),
    );
    expect(quo.total).toBe(1035);
    await expectZeroEverywhere("edited after approval");
  });

  it("DECLINE records the customer's answer; the quotation stops being live", async () => {
    const quo = await inTenant(() => quotationsService.setOutcome(quotationId, "declined", userId));
    expect(quo.outcome).toBe("declined");
    await expectZeroEverywhere("declined");
    // A declined quotation is no longer editable.
    await expect(inTenant(() => quotationsService.update(quotationId, { notes: "x" }))).rejects.toMatchObject({
      statusCode: 409,
    });
    // …and cannot be declined twice.
    await expect(inTenant(() => quotationsService.setOutcome(quotationId, "closed", userId))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("REOPEN undoes a mistaken decline", async () => {
    const quo = await inTenant(() => quotationsService.reopen(quotationId));
    expect(quo.outcome).toBeNull();
  });

  it("an outcome cannot be set on a quotation that was never issued", async () => {
    const draft = await inTenant(() =>
      quotationsService.create({ date: DATE, customerId, items: [{ description: "d", quantity: 1, unitPrice: 1 }] }, userId),
    );
    await expect(inTenant(() => quotationsService.setOutcome(draft.id, "declined", userId))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("rejects lines that are not lines (named 400s, never a DB 500)", async () => {
    const bad = (items: unknown) =>
      inTenant(() => quotationsService.create({ date: DATE, customerId, items }, userId));
    await expect(bad([])).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad([{ description: "x", quantity: 0, unitPrice: 5 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad([{ description: "x", quantity: -1, unitPrice: 5 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad([{ description: "x", quantity: "abc", unitPrice: 5 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad([{ description: "  ", quantity: 1, unitPrice: 5 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad([{ description: "x", quantity: 1, unitPrice: 5, vatRate: 500 }])).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a quotation dated in a CLOSED period is allowed — the lock guards the ledger", async () => {
    await pool.query(
      `INSERT INTO period_locks (organization_id, company_id, period, locked_by)
       VALUES ($1,$2,'2026-03',$3) ON CONFLICT DO NOTHING`,
      [orgId, companyId, userId],
    );
    const quo = await inTenant(() =>
      quotationsService.create({ date: "2026-03-10", customerId, items: [{ description: "in a closed month", quantity: 1, unitPrice: 10 }] }, userId),
    );
    expect(quo.date).toBe("2026-03-10");
    await pool.query(`DELETE FROM period_locks WHERE organization_id = $1`, [orgId]);
  });

  /**
   * 🔴 THE ANTI-VACUITY TEST.
   *
   * Everything above asserts that figures did NOT move. That is only evidence
   * if the same figures CAN move — otherwise the suite would pass against
   * reports that always return zero, which is exactly how flaw #8's Zakat
   * "computed 0" survived four tests. So: post a real invoice on the same org
   * through the ordinary path and prove the identical snapshot DOES change.
   */
  it("🔴 the reports are load-bearing: a real invoice MOVES the same figures", async () => {
    const before = await inTenant(financialSnapshot);
    await inTenant(() =>
      createApproved(invoicesService, {
          invoiceNumber: "INV-QUO-PROOF-1",
          date: DATE,
          customerId,
          items: [{ description: "Real supply", quantity: 1, unitPrice: 500, vatRate: 15 }],
        },
        userId),
    );
    const after = await inTenant(financialSnapshot);
    expect(after.revenue, "revenue must move for a real invoice").not.toBe(before.revenue);
    expect(after.accountsReceivable, "AR must move for a real invoice").not.toBe(before.accountsReceivable);
    expect(after.vatOutput, "output VAT must move for a real invoice").not.toBe(before.vatOutput);
  });
});

/** Pure derivation — no database needed. */
describe("conversionState (the derived axis)", () => {
  it("no lines is OPEN, never 'converted'", () => {
    // A quotation with nothing on it has nothing to convert. Reporting that as
    // `converted` would be a confident wrong answer.
    expect(conversionState([])).toBe("open");
  });

  it("nothing converted → open", () => {
    expect(conversionState([{ quantity: 10, convertedQuantity: 0 }])).toBe("open");
  });

  it("some converted → partially_converted", () => {
    expect(conversionState([{ quantity: 10, convertedQuantity: 4 }])).toBe("partially_converted");
  });

  it("all converted → converted", () => {
    expect(conversionState([{ quantity: 10, convertedQuantity: 10 }])).toBe("converted");
  });

  it("🔴 a fractional remainder keeps it OPEN rather than rounding it closed", () => {
    // 9.999 of 10 is not 10. Rounding this to `converted` would silently
    // abandon a real remaining unit.
    expect(conversionState([{ quantity: 10, convertedQuantity: 9.9 }])).toBe("partially_converted");
  });

  it("spans lines: one line full, another untouched, is still partial", () => {
    expect(
      conversionState([
        { quantity: 5, convertedQuantity: 5 },
        { quantity: 5, convertedQuantity: 0 },
      ]),
    ).toBe("partially_converted");
  });
});

/**
 * The permission matrix, asserted rather than assumed.
 *
 * RBAC is FAIL-CLOSED: a resource with no seeded grants 403s on every route,
 * so "we added the routes" and "the routes are reachable" are different facts.
 * The 2026-08-20 audit recorded that the permission-matrix SEEDS are unaudited
 * (enforcement was audited; the grants were not) — this milestone should not
 * widen that gap, so its own grants are pinned here.
 *
 * The assertion that matters is the NEGATIVE one: a bookkeeper must not hold
 * `approve`. Approval is what releases a price to a customer.
 */
describe("quotations permission grants", () => {
  const grants = PERMISSION_MATRIX.filter((p) => p.resource === "quotations");
  const rolesFor = (action: string) => grants.filter((g) => g.action === action).map((g) => g.role).sort();

  it("exists at all — an unseeded resource 403s on every route", () => {
    expect(grants.length, "no quotations grants seeded").toBeGreaterThan(0);
  });

  it("every role can read", () => {
    expect(rolesFor("read")).toEqual(["accountant", "admin", "bookkeeper", "viewer"]);
  });

  it("a bookkeeper may draft and edit", () => {
    expect(rolesFor("create")).toContain("bookkeeper");
    expect(rolesFor("update")).toContain("bookkeeper");
  });

  it("🔴 a bookkeeper may NOT approve — issuing a price is a commitment", () => {
    expect(rolesFor("approve")).toEqual(["accountant", "admin"]);
    expect(rolesFor("approve")).not.toContain("bookkeeper");
    expect(rolesFor("approve")).not.toContain("viewer");
  });

  it("only an admin may delete the record of what was offered", () => {
    expect(rolesFor("delete")).toEqual(["admin"]);
  });

  it("a viewer holds read and nothing else", () => {
    expect(grants.filter((g) => g.role === "viewer").map((g) => g.action)).toEqual(["read"]);
  });
});
