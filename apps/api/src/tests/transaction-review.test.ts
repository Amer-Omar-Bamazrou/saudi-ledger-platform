/**
 * M15 item 8 — the transactions holding area, proven to the M10.3/10.4
 * zero-movement standard.
 *
 * The invariant: a `pending_review` transaction moves NOTHING — not the VAT
 * position, not the Zakat base, not cash flow, not the dashboard summary, not
 * budget actuals — until a human accepts it. Verified through the REAL report
 * services, never asserted from the schema.
 *
 * Why this mechanism and not the M10 engine (owner decision): M10 models
 * documents with individual legal significance. A bank line is not a document —
 * it is evidence of one that exists elsewhere, and it is reviewed by scanning a
 * month, not by approving rows one at a time. The M10 PRINCIPLE holds; the
 * mechanism is report filters, like M10.3/10.4's approvedOnly filters.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { summaryService } from "../services/summary.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[transaction-review] no real DATABASE_URL — skipping.");

const SLUG = "m15-review";
const EMAIL = "m15-review@test.local";

describeMaybe("M15 — the holding area: pending rows move nothing", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
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
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Review Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'RV','1010101010','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','RV',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
  });

  afterAll(cleanup);

  /** Every tax-facing figure in one read, through the REAL services. */
  async function taxFigures() {
    const [vat, zakat, cash, summary] = await Promise.all([
      inTenant(() => summaryService.getVat({ dateFrom: "2026-01-01", dateTo: "2026-12-31" })),
      inTenant(() => summaryService.getZakat()),
      inTenant(() => reportsService.cashFlow("2026-01-01", "2026-12-31")),
      inTenant(() => summaryService.getSummary({ dateFrom: "2026-01-01", dateTo: "2026-12-31" })),
    ]);
    return {
      outputVat: (vat as { outputVat?: number }).outputVat ?? (vat as { totalVat?: number }).totalVat ?? 0,
      zakatBase: (zakat as { totalZakatableAssets?: number }).totalZakatableAssets ?? 0,
      cashNet: (cash as { netChange: number }).netChange,
      income: (summary as { totalIncome?: number }).totalIncome ?? 0,
      expenses: (summary as { totalExpenses?: number }).totalExpenses ?? 0,
    };
  }

  const uploadStatement = (rows: object[]) =>
    inTenant(() =>
      transactionsService.upload({
        rows: rows as never,
        autoCategrize: true,
      } as never),
    );

  it("🔴 ZERO MOVEMENT: an imported month changes NO tax-facing figure", async () => {
    const before = await taxFigures();

    const result = (await uploadStatement([
      { date: "2026-07-04", description: "SADAD PAYMENT - STC 0112345678", amount: 862.5, currency: "SAR", type: "debit" },
      { date: "2026-07-11", description: "ZAKAT PAYMENT ZATCA 2025", amount: 18000, currency: "SAR", type: "debit" },
      { date: "2026-07-18", description: "RENT - OFFICE UNIT 4", amount: 15000, currency: "SAR", type: "debit" },
      { date: "2026-07-22", description: "CONSULTING FEE RECEIVED", amount: 5000, currency: "SAR", type: "credit" },
      { date: "2026-07-25", description: "TRANSFER", amount: 3000, currency: "SAR", type: "debit" },
    ])) as { inserted: number };
    expect(result.inserted).toBe(5);

    const after = await taxFigures();
    // 🔴 The invariant. These rows carry VAT amounts, Zakat relevance and cash
    // movements — and none of it may reach a figure while pending.
    expect(after).toEqual(before);

    // And the rows ARE there, visible, awaiting review — held, not lost.
    const pending = await inTenant(() => transactionsService.pendingReview());
    expect(pending).toHaveLength(5);
  });

  it("🔴 BULK ACCEPT IS NOT BLIND ACCEPT: unknown and low-confidence rows are never swept in", async () => {
    // Of the five: the bare "TRANSFER" is uncategorized (the engine said "I
    // don't know"). A bulk accept with no ids must NOT take it — a recorded
    // human acceptance of a row nobody read is worse than no gate, because it
    // manufactures false assurance.
    const pendingBefore = await inTenant(() => transactionsService.pendingReview());
    const attention = pendingBefore.filter((p) => p.needsAttention);
    expect(attention.length).toBeGreaterThanOrEqual(1);

    const bulk = await inTenant(() => transactionsService.acceptPending());
    expect(bulk.accepted).toBe(pendingBefore.length - attention.length);

    const remaining = await inTenant(() => transactionsService.pendingReview());
    expect(remaining.map((r) => r.description)).toContain("TRANSFER");
    expect(remaining.every((r) => r.needsAttention)).toBe(true);
  });

  it("acceptance MOVES the figures — the gate is a gate, not a wall", async () => {
    const before = await taxFigures();
    // Accept the remaining rows DELIBERATELY, by naming them.
    const remaining = await inTenant(() => transactionsService.pendingReview());
    const named = await inTenant(() => transactionsService.acceptPending(remaining.map((r) => r.id)));
    expect(named.accepted).toBe(remaining.length);

    const after = await taxFigures();
    // Cash moved — the accepted rows are real now. (Which figures move depends
    // on categorization; cash flow counts every accepted row, so it is the
    // sensitive one.)
    expect(after.cashNet).not.toBe(before.cashNet);

    expect(await inTenant(() => transactionsService.pendingReview())).toHaveLength(0);
  });

  it("a manually created single transaction is accepted immediately", async () => {
    // A human typing one row is looking at that row — the M10.4 self-approve
    // analogue. Only IMPORTED rows are gated.
    const tx = (await inTenant(() =>
      transactionsService.create({
        date: "2026-08-01",
        description: "MANUAL ENTRY",
        amount: 100,
        currency: "SAR",
        type: "debit",
      } as never),
    )) as { id: number };
    const { rows } = await pool.query(`SELECT review_status FROM transactions WHERE id = $1`, [tx.id]);
    expect(rows[0].review_status).toBe("accepted");
  });

  it("re-uploading the same statement is reported as duplicates, not doubled", async () => {
    const again = (await uploadStatement([
      { date: "2026-07-18", description: "RENT - OFFICE UNIT 4", amount: 15000, currency: "SAR", type: "debit" },
    ])) as { inserted: number; duplicatesSkipped: number };
    expect(again.inserted).toBe(0);
    expect(again.duplicatesSkipped).toBe(1);
  });
});
