/**
 * M19.6 — the receivables bridge.
 *
 *     opening + invoiced − collected − credited − other = closing
 *
 * 🔴 WHY THIS IS WORTH A TEST FILE. The bridge answers what the receivables
 * STOCK cannot: a rising AR balance does not say whether you invoiced more or
 * collected less, and those call for opposite responses. That only works if the
 * five terms actually reconcile — a bridge that is approximately right is a
 * bridge that will be quietly disbelieved and then quietly ignored.
 *
 * The identity holds by CONSTRUCTION (every term is a debit or a credit on one
 * GL account), so these tests are not checking arithmetic the code might have
 * got wrong. They are checking that the LABELLING is right and exhaustive:
 * every credit lands in exactly one bucket, a credit note is not counted as a
 * payment, a debit note is not counted as a reversal, and nothing falls through
 * a NULL predicate into no bucket at all — which is the one way the identity
 * COULD break, and the reason the SQL coalesces its filters.
 *
 * And per the M13 AR-agreement pattern: `closing` is pinned against
 * `reports.balanceSheet`, because two computations of one fact that are never
 * compared are meta-finding #9 waiting to happen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { analyticsService } from "../services/analytics.service";
import { invoicesService } from "../services/invoices.service";
import { reportsService } from "../services/reports.service";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[analytics-bridge] no real DATABASE_URL — skipping.");

const SLUG = "m19-bridge";
const EMAIL = "m19-bridge@test.local";

describeMaybe("M19.6 — the receivables bridge", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let seq = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({
      organizationId: orgId,
      companyId,
      role: "authenticated",
    });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn),
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
    for (const t of [
      "journal_entry_lines",
      "journal_entries",
      "invoice_items",
      "invoice_payments",

      "invoices",
      "customers",
      "categories",
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(
      `DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`,
    );
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ('Bridge Org','${SLUG}') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(
        // A VAT number is required to APPROVE an invoice (sellerIdentity fails
        // closed) — the bridge only ever sees approved documents.
        `INSERT INTO companies (organization_id, name, cr_number, vat_number)
         VALUES ($1,'Bridge Co','1010101012','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active)
         VALUES ('${EMAIL}','BR',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status)
       VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(
        `INSERT INTO customers (organization_id, name) VALUES ($1,'Bridge Customer') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  /** An approved invoice for `net` + 15% VAT, dated `date`. */
  const invoice = (date: string, net: number) =>
    inTenant(() =>
      createApproved(invoicesService, {
          invoiceNumber: `BR-${++seq}`,
          date,
          dueDate: date,
          customerId,
          items: [{ description: "Service", quantity: 1, unitPrice: net, vatRate: 15 }],
        },
        userId),
    );

  const creditNote = (date: string, originalId: number, net: number) =>
    inTenant(() =>
      createApproved(invoicesService, {
          invoiceNumber: `BR-CN-${++seq}`,
          date,
          customerId,
          documentType: "credit_note",
          originalInvoiceId: originalId,
          noteReason: "Agreed reduction",
          items: [{ description: "Reduction", quantity: 1, unitPrice: net, vatRate: 15 }],
        },
        userId),
    );

  const bridge = () => inTenant(() => analyticsService.receivablesBridge("2026-01", "2026-05"));

  let inv1: { id: number; total: string };

  it("🔴 THE IDENTITY holds on every point, from the first month", async () => {
    inv1 = (await invoice("2026-01-10", 10_000)) as never; // 11,500 incl. VAT

    const points = await bridge();
    for (const p of points) {
      const derived = p.opening + p.invoiced - p.collected - p.credited - p.other;
      expect(
        Math.abs(derived - p.closing),
        `${p.period}: ${p.opening} + ${p.invoiced} − ${p.collected} − ${p.credited} − ${p.other} ≠ ${p.closing}`,
      ).toBeLessThan(0.005);
    }
    expect(points[0]!.opening, "no history before the window").toBe(0);
    expect(points[0]!.invoiced).toBe(11_500);
    expect(points[0]!.closing).toBe(11_500);
  });

  it("each month opens where the previous one closed", async () => {
    const points = await bridge();
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.opening, `${points[i]!.period} opening`).toBe(points[i - 1]!.closing);
    }
  });

  it("🔴 a PAYMENT is collected, not credited", async () => {
    await inTenant(() =>
      invoicesService.pay(inv1.id, { amount: 5_000, paidAt: "2026-02-14" }, userId),
    );

    const feb = (await bridge()).find((p) => p.period === "2026-02")!;
    expect(feb.collected).toBe(5_000);
    expect(feb.credited).toBe(0);
    expect(feb.other, "a payment must never fall through to 'other'").toBe(0);
    expect(feb.closing).toBe(6_500);
  });

  it("🔴 a CREDIT NOTE is credited, not collected — the two mean opposite things", async () => {
    // Collected is money in; credited is money never coming. Charting a credit
    // note as a collection would report a cash improvement that did not happen.
    await creditNote("2026-03-05", inv1.id, 2_000); // 2,300 incl. VAT

    const mar = (await bridge()).find((p) => p.period === "2026-03")!;
    expect(mar.credited).toBe(2_300);
    expect(mar.collected).toBe(0);
    expect(mar.other).toBe(0);
    expect(mar.closing).toBe(4_200);
  });

  it("🔴 a DEBIT NOTE is invoiced, not a reversal", async () => {
    // A debit note posts like an invoice (§4 / CLAUDE.md). Treating it as a
    // reversal would understate receivables.
    await inTenant(() =>
      createApproved(invoicesService, {
          invoiceNumber: `BR-DN-${++seq}`,
          date: "2026-04-08",
          customerId,
          documentType: "debit_note",
          originalInvoiceId: inv1.id,
          noteReason: "Undercharged freight",
          items: [{ description: "Freight", quantity: 1, unitPrice: 1_000, vatRate: 15 }],
        },
        userId),
    );

    const apr = (await bridge()).find((p) => p.period === "2026-04")!;
    expect(apr.invoiced).toBe(1_150);
    expect(apr.credited).toBe(0);
    expect(apr.closing).toBe(5_350);
  });

  it("🔴 closing AGREES with the balance sheet — two computations, pinned", async () => {
    // The M13 AR-agreement pattern. It holds by construction here, but "by
    // construction" is a claim about the code, and this is the observation.
    const points = await bridge();
    for (const p of points) {
      const [y, m] = p.period.split("-").map(Number);
      const asOf = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
      const bs = await inTenant(() => reportsService.balanceSheet(asOf));
      expect(
        Math.abs(bs.assets.accountsReceivable - p.closing),
        `${p.period}: bridge ${p.closing} vs balance sheet ${bs.assets.accountsReceivable}`,
      ).toBeLessThan(0.005);
    }
  });

  it("🔴 every credit lands in exactly ONE bucket — nothing falls through", async () => {
    // The single way the identity could break: a NULL contra predicate putting
    // a credit in no bucket. The SQL coalesces its filters; this is the
    // observation that it worked, expressed as a property rather than a figure.
    const points = await bridge();
    const totalCredits = points.reduce((s, p) => s + p.collected + p.credited + p.other, 0);
    const totalDebits = points.reduce((s, p) => s + p.invoiced, 0);
    const last = points[points.length - 1]!;
    expect(Math.abs(totalDebits - totalCredits - last.closing)).toBeLessThan(0.005);
  });

  it("months with no receivables activity still produce a point", async () => {
    // A balance persists whether or not anything happened; a gap in the axis
    // would read as "no data" when it means "nothing changed".
    const may = (await bridge()).find((p) => p.period === "2026-05")!;
    expect(may.invoiced).toBe(0);
    expect(may.collected).toBe(0);
    expect(may.opening).toBe(may.closing);
    expect(may.closing).toBe(5_350);
  });

  it("a window starting mid-history opens with the balance, not with zero", async () => {
    // Starting from zero would report the whole prior history as this month's
    // invoicing — the bridge's most plausible wrong answer.
    const points = await inTenant(() => analyticsService.receivablesBridge("2026-04", "2026-05"));
    expect(points[0]!.opening).toBe(4_200);
    expect(points[0]!.period).toBe("2026-04");
  });
});
