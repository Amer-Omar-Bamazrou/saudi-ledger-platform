/**
 * AI-3a — findings: deterministic internal-consistency checks as rows with
 * state.
 *
 * The properties that matter:
 *   1. Each check DETECTS its condition when built (never hoped for — the
 *      stuckDocument discipline) and stays quiet on clean data.
 *   2. 🔴 The lifecycle: re-running upserts (no duplicate rows); an
 *      acknowledged finding SURVIVES re-detection; a vanished condition is
 *      machine-resolved and the row KEPT; a resolved condition that returns
 *      REOPENS.
 *   3. 🔴 ZERO MOVEMENT: a findings run changes no report figure — probed
 *      through the real report services, against captured baselines.
 *   4. The grants: any role reads, write roles run, ONLY approver roles
 *      acknowledge — a bookkeeper dismissing a duplicate-payment warning is
 *      the negative that matters.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool, PERMISSION_MATRIX } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { findingsService, ALL_FINDING_KINDS } from "../services/findings.service";
import { summaryService } from "../services/summary.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[findings] no real DATABASE_URL — skipping.");

const SLUG = "ai3a-findings";
const EMAIL = "ai3a-findings@test.local";

describeMaybe("AI-3a — findings", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
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
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM finding_runs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM finding_schedules WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM findings WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bill_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Findings Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'FN','1010101021','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','FN',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    vendorId = (
      await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'FN Vendor') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(cleanup);

  // ── Detection: every check fires on a BUILT condition ─────────────────────

  it("a clean organization produces zero findings", async () => {
    const r = await inTenant(() => findingsService.run());
    expect(r).toMatchObject({ created: 0, reopened: 0, resolved: 0, open: 0 });
  });

  it("detects each built condition — one finding per kind, facts carried", async () => {
    // duplicate_bill: same vendor, date, total — twice.
    for (const n of ["FN-DUP-1", "FN-DUP-2"]) {
      await pool.query(
        `INSERT INTO bills (organization_id, company_id, bill_number, vendor_id, date, due_date, status, subtotal, vat_amount, total)
         VALUES ($1,$2,$3,$4,'2026-08-01','2026-08-15','approved',100,15,115)`,
        [orgId, companyId, n, vendorId],
      );
    }
    // overdue_payable rides on the same bills (due 2026-08-15, unpaid).
    // duplicate_transaction + undeclared_transfer + unposted_transaction:
    await pool.query(
      `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, kind, review_status)
       VALUES ($1,$2,'2026-08-02','FN SAME ROW','250.00','debit','operating','accepted'),
              ($1,$2,'2026-08-02','FN SAME ROW','250.00','debit','operating','accepted'),
              ($1,$2,'2026-08-03','FN MYSTERY TRANSFER','1000.00','debit','transfer','accepted')`,
      [orgId, companyId],
    );
    // invoice_number_gap: counter-shaped numbers with 45..47 absent.
    for (const n of ["INV-2026-000044", "INV-2026-000048"]) {
      await pool.query(
        `INSERT INTO invoices (organization_id, company_id, invoice_number, date, due_date, status, subtotal, vat_amount, total, paid_amount)
         VALUES ($1,$2,$3,'2026-07-01','2026-07-10','sent',100,15,115,0)`,
        [orgId, companyId, n],
      );
    }
    // The 'sent' invoices are also overdue_receivable (due 2026-07-10, unpaid).
    // stale_draft: a draft created beyond the threshold.
    await pool.query(
      `INSERT INTO invoices (organization_id, company_id, invoice_number, date, status, subtotal, vat_amount, total, created_at)
       VALUES ($1,$2,'FN-STALE-1','2026-08-01','draft',100,15,115, now() - interval '30 days')`,
      [orgId, companyId],
    );

    const r = await inTenant(() => findingsService.run());
    expect(r.created).toBeGreaterThan(0);

    const { findings } = await inTenant(() => findingsService.list({}, orgId));
    const kinds = new Set(findings.map((f) => f.kind));
    for (const k of ALL_FINDING_KINDS) {
      expect(kinds.has(k), `expected a ${k} finding`).toBe(true);
    }

    const gap = findings.find((f) => f.kind === "invoice_number_gap")!;
    expect(gap.facts).toMatchObject({ afterNumber: "INV-2026-000044", missingFrom: 45, missingTo: 47, missingCount: 3 });
    const dupTx = findings.find((f) => f.kind === "duplicate_transaction")!;
    expect(dupTx.facts).toMatchObject({ count: 2, description: "FN SAME ROW" });
  });

  it("🔴 the credit-aware half: a fully-credited overdue invoice is NOT an overdue_receivable", async () => {
    // Credit the 044 invoice in full — Tier 3's lesson: outstanding nets notes.
    const { rows } = await pool.query(
      `SELECT id FROM invoices WHERE organization_id = $1 AND invoice_number = 'INV-2026-000044'`,
      [orgId],
    );
    await pool.query(
      `INSERT INTO invoices (organization_id, company_id, invoice_number, date, status, document_type, original_invoice_id, note_reason, subtotal, vat_amount, total)
       VALUES ($1,$2,'FN-CN-1','2026-07-20','sent','credit_note',$3,'full credit',100,15,115)`,
      [orgId, companyId, rows[0].id],
    );
    await inTenant(() => findingsService.run());
    const { findings } = await inTenant(() => findingsService.list({ kind: "overdue_receivable" }, orgId));
    const still = findings.filter((f) => f.status !== "resolved").map((f) => (f.facts as any).invoiceNumber);
    expect(still).not.toContain("INV-2026-000044");
    expect(still).toContain("INV-2026-000048");
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it("🔴 re-running UPSERTS — same open count, no duplicate rows", async () => {
    const before = await inTenant(() => findingsService.list({}, orgId));
    const r = await inTenant(() => findingsService.run());
    expect(r.created).toBe(0);
    const after = await inTenant(() => findingsService.list({}, orgId));
    expect(after.findings.length).toBe(before.findings.length);
  });

  it("🔴 an acknowledged finding SURVIVES re-detection — the machine never un-acknowledges a human", async () => {
    const { findings } = await inTenant(() => findingsService.list({ kind: "duplicate_bill" }, orgId));
    const target = findings.find((f) => f.status === "open")!;
    const acked = await inTenant(() => findingsService.acknowledge(target.id, userId, orgId));
    expect(acked.status).toBe("acknowledged");
    expect(acked.acknowledgedByName).toBeTruthy(); // resolved via the org's own memberships (M23 precedent)

    await inTenant(() => findingsService.run());
    const again = await inTenant(() => findingsService.list({ kind: "duplicate_bill" }, orgId));
    expect(again.findings.find((f) => f.id === target.id)!.status).toBe("acknowledged");
  });

  it("🔴 a vanished condition is machine-RESOLVED and the row KEPT; returning REOPENS it", async () => {
    // Declare the mystery transfer — the condition vanishes.
    await pool.query(
      `UPDATE transactions SET transfer_direction = 'own_account' WHERE organization_id = $1 AND description = 'FN MYSTERY TRANSFER'`,
      [orgId],
    );
    let r = await inTenant(() => findingsService.run());
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    let { findings } = await inTenant(() => findingsService.list({ kind: "undeclared_transfer" }, orgId));
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("resolved");

    // Un-declare it — the same row reopens rather than duplicating.
    await pool.query(
      `UPDATE transactions SET transfer_direction = NULL WHERE organization_id = $1 AND description = 'FN MYSTERY TRANSFER'`,
      [orgId],
    );
    r = await inTenant(() => findingsService.run());
    expect(r.reopened).toBeGreaterThanOrEqual(1);
    ({ findings } = await inTenant(() => findingsService.list({ kind: "undeclared_transfer" }, orgId)));
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("open");
  });

  it("acknowledging a RESOLVED finding refuses — there is nothing left to accept", async () => {
    await pool.query(
      `UPDATE transactions SET transfer_direction = 'own_account' WHERE organization_id = $1 AND description = 'FN MYSTERY TRANSFER'`,
      [orgId],
    );
    await inTenant(() => findingsService.run());
    const { findings } = await inTenant(() => findingsService.list({ kind: "undeclared_transfer" }, orgId));
    await expect(inTenant(() => findingsService.acknowledge(findings[0].id, userId, orgId))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  // ── Zero movement ─────────────────────────────────────────────────────────

  it("🔴 a findings run moves NOTHING — income statement and VAT probed through the real services", async () => {
    const range = { dateFrom: "2026-01-01", dateTo: "2026-12-31" };
    const [isBefore, vatBefore] = await Promise.all([
      inTenant(() => reportsService.incomeStatement(range.dateFrom, range.dateTo)),
      inTenant(() => summaryService.getVat(range)),
    ]);
    await inTenant(() => findingsService.run());
    const [isAfter, vatAfter] = await Promise.all([
      inTenant(() => reportsService.incomeStatement(range.dateFrom, range.dateTo)),
      inTenant(() => summaryService.getVat(range)),
    ]);
    expect(isAfter).toEqual(isBefore);
    expect(vatAfter).toEqual(vatBefore);
  });

  // ── The grants ────────────────────────────────────────────────────────────

  it("grants: every role reads; write roles run; ONLY approvers acknowledge (the bookkeeper negative)", () => {
    const has = (role: string, action: string) =>
      PERMISSION_MATRIX.some((p) => p.role === role && p.resource === "findings" && p.action === action);
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) expect(has(role, "read"), `${role} read`).toBe(true);
    for (const role of ["admin", "accountant", "bookkeeper"]) expect(has(role, "create"), `${role} create`).toBe(true);
    expect(has("viewer", "create")).toBe(false);
    for (const role of ["admin", "accountant"]) expect(has(role, "approve"), `${role} approve`).toBe(true);
    // 🔴 The negative that matters: a bookkeeper may surface a warning about
    // money but may not dismiss one.
    expect(has("bookkeeper", "approve")).toBe(false);
    expect(has("viewer", "approve")).toBe(false);
  });
});
