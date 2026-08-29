/**
 * M12.1a — the two multi-company invoice bugs, proven and fixed.
 *
 * Both are PRE-EXISTING platform bugs, invisible while every organization had
 * exactly one company. ZATCA Phase 2 escalates them from latent to
 * compliance-breaking, which is why they are fixed here rather than in M12.3.
 *
 * ── BUG 1: the hash chain was ORG-scoped, not COMPANY-scoped ────────────────
 * `getPreviousInvoiceHash(db, invoicesTable)` filtered only on
 * `invoice_hash IS NOT NULL` and ordered by id. RLS confined it to the active
 * organization but NOT to a company, so an org with two companies INTERLEAVED
 * their chains into one. ZATCA's chain (and the ICV counter) are per EGS unit —
 * i.e. per company — so an interleaved chain is invalid.
 *
 *   Before the fix, issuing A1 → B1 → A2 gives   A2.previous_hash === B1.hash
 *   After  the fix,                              A2.previous_hash === A1.hash
 *
 * ── BUG 2: seller identity came from the FIRST-CREATED company ──────────────
 * `requireIssuanceSeller()` called `companiesRepository.findActive()`, ignoring
 * the `companyId` the invoice already carries. A company-B invoice was stamped
 * with company A's VAT number and legal name — and under Phase 2 would be signed
 * with company A's certificate.
 *
 *   Before the fix, a company-B invoice carries VAT_A.
 *   After  the fix,                            VAT_B.
 *
 * DB-backed; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { invoicesService } from "../services/invoices.service";
import { auditContext } from "../lib/auditContext";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[m12.1a multi-company] no real DATABASE_URL — skipping.");
}

const SLUG = "m121a-multico";

// Two DISTINCT registered entities inside ONE organization.
const CO_A = { name: "Alpha Trading Est.", vat: "310123456789013" };
const CO_B = { name: "Beta Logistics Co.", vat: "311987654321003" };

describeMaybe("M12.1a — multi-company invoice identity + hash chain", () => {
  let orgId = "";
  let companyA = "";
  let companyB = "";
  let userId = 0;
  let customerId = 0;

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const U = `(SELECT id FROM users WHERE email LIKE 'm121a-%')`;
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM security_audit_logs WHERE organization_id IN ${O} OR actor_user_id IN ${U}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${O})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'm121a-%'`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  /** Run `fn` as the tenant, with a SPECIFIC company active. */
  async function asCompany<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const result = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: null }, () => fn()),
      );
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const newInvoice = (invoiceNumber: string) => ({
    invoiceNumber,
    customerId,
    date: "2026-04-01",
    dueDate: "2026-05-01",
    status: "draft",
    items: [{ description: "Freight", quantity: 1, unitPrice: 1000, vatRate: 15 }],
  });

  /** Issue an invoice under `companyId` (approver path → immediate issuance). */
  const issue = (companyId: string, number: string) =>
    asCompany(companyId, () => createApproved(invoicesService, newInvoice(number) as any, userId));

  const row = async (number: string) =>
    (
      await pool.query(
        `SELECT invoice_number, company_id, icv, issued_at, document_type,
                previous_hash, invoice_hash, seller_name, seller_vat_number
           FROM invoices WHERE organization_id = $1 AND invoice_number = $2`,
        [orgId, number],
      )
    ).rows[0];

  beforeAll(async () => {
    await cleanup();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status)
         VALUES ('M121a MultiCo', '${SLUG}', 'approved') RETURNING id`,
      )
    ).rows[0].id;

    // Company A is created FIRST — so it is what the old `findActive()` returned
    // for every invoice in the org, regardless of the invoice's own company.
    companyA = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, vat_number) VALUES ($1,$2,$3) RETURNING id`,
        [orgId, CO_A.name, CO_A.vat],
      )
    ).rows[0].id;
    companyB = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, vat_number) VALUES ($1,$2,$3) RETURNING id`,
        [orgId, CO_B.name, CO_B.vat],
      )
    ).rows[0].id;

    userId = (
      await pool.query(
        `INSERT INTO users (email,name,password_hash,role,is_active)
         VALUES ('m121a-user@test.local','M121a Tester',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'MultiCo Customer') RETURNING id`, [
        orgId,
      ])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── BUG 2 — seller identity follows the INVOICE's company ─────────────────

  it("BUG 2: an invoice issued under company B carries B's VAT, not the first company's", async () => {
    await issue(companyA, "MC-A1");
    await issue(companyB, "MC-B1");

    const a1 = await row("MC-A1");
    const b1 = await row("MC-B1");

    expect(a1.company_id).toBe(companyA);
    expect(b1.company_id).toBe(companyB);

    // Company A behaves the same as before (it IS the first-created company).
    expect(a1.seller_vat_number).toBe(CO_A.vat);
    expect(a1.seller_name).toBe(CO_A.name);

    // THE FIX: before it, this row carried CO_A's identity — the wrong legal
    // entity, and under Phase 2 the wrong signing certificate.
    expect(b1.seller_vat_number).toBe(CO_B.vat);
    expect(b1.seller_name).toBe(CO_B.name);
    expect(b1.seller_vat_number).not.toBe(CO_A.vat);
  });

  // ── BUG 1 — the chain does not interleave across companies ────────────────

  it("BUG 1: interleaved issuance keeps each company's chain separate", async () => {
    // Issue A2 AFTER B1. The most recent hash in the ORG belongs to company B,
    // so the old org-scoped lookup chained A2 → B1.
    await issue(companyA, "MC-A2");

    const a1 = await row("MC-A1");
    const b1 = await row("MC-B1");
    const a2 = await row("MC-A2");

    // THE FIX: A2 links to A1 (same company), NOT to B1 (the org-wide latest).
    expect(a2.previous_hash).toBe(a1.invoice_hash);
    expect(a2.previous_hash).not.toBe(b1.invoice_hash);

    // And B's chain starts fresh rather than inheriting A1.
    expect(b1.previous_hash).toBe("GENESIS");
  });

  it("BUG 1: each company's chain is internally continuous", async () => {
    await issue(companyB, "MC-B2");

    for (const [company, numbers] of [
      [companyA, ["MC-A1", "MC-A2"]],
      [companyB, ["MC-B1", "MC-B2"]],
    ] as const) {
      const rows = await Promise.all(numbers.map(row));
      expect(rows.every((r) => r.company_id === company)).toBe(true);
      // First link is genesis; every later link points at its predecessor.
      expect(rows[0].previous_hash).toBe("GENESIS");
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].previous_hash).toBe(rows[i - 1].invoice_hash);
      }
    }

    // Exactly ONE genesis root per company — not one for the whole org.
    const roots = await pool.query(
      `SELECT company_id, count(*)::int c FROM invoices
        WHERE organization_id = $1 AND previous_hash = 'GENESIS' GROUP BY 1`,
      [orgId],
    );
    expect(roots.rows).toHaveLength(2);
    expect(roots.rows.every((r) => r.c === 1)).toBe(true);
  });

  // ── M12.1a schema — identity fields ──────────────────────────────────────

  it("issuance stamps a real issued_at, distinct from the accounting date", async () => {
    const a1 = await row("MC-A1");
    expect(a1.issued_at).toBeTruthy();
    // Previously a fabricated `${date}T00:00:00Z` was fed to the QR. A real
    // timestamp has a non-zero time component essentially always.
    const iso = new Date(a1.issued_at).toISOString();
    expect(iso).not.toBe("2026-04-01T00:00:00.000Z");
    expect(a1.document_type).toBe("invoice");
  });

  it("drafts still consume no sequence number (M10.4 invariant intact)", async () => {
    await asCompany(companyA, () => invoicesService.create(newInvoice("MC-A-DRAFT") as any, userId));
    const draft = await row("MC-A-DRAFT");
    expect(draft.invoice_hash).toBeNull();
    expect(draft.icv).toBeNull();
    expect(draft.issued_at).toBeNull();

    // The next issued invoice chains past the draft, which is invisible to it.
    await issue(companyA, "MC-A3");
    const a2 = await row("MC-A2");
    const a3 = await row("MC-A3");
    expect(a3.previous_hash).toBe(a2.invoice_hash);
  });

  it("the DB rejects a reused ICV within a company, but allows it across companies", async () => {
    const a1 = await row("MC-A1");
    const b1 = await row("MC-B1");

    await pool.query(`UPDATE invoices SET icv = 1 WHERE organization_id = $1 AND invoice_number = 'MC-A1'`, [orgId]);
    // Same counter value under a DIFFERENT company is legitimate — each EGS unit
    // has its own sequence.
    await expect(
      pool.query(`UPDATE invoices SET icv = 1 WHERE organization_id = $1 AND invoice_number = 'MC-B1'`, [orgId]),
    ).resolves.toBeTruthy();

    // Reusing it within the SAME company must be impossible.
    await expect(
      pool.query(`UPDATE invoices SET icv = 1 WHERE organization_id = $1 AND invoice_number = 'MC-A2'`, [orgId]),
    ).rejects.toMatchObject({ code: "23505" });

    expect(a1.company_id).toBe(companyA);
    expect(b1.company_id).toBe(companyB);
  });
});
