/**
 * AUD-1 / AUD-2 — THE CALLERS THAT BYPASS THE ALLOCATOR.
 *
 * ── 🔴 WHY THIS FILE EXISTS ────────────────────────────────────────────────
 * C12 read the primary texts, established that a company must run ONE
 * non-resetting number sequence spanning invoices AND notes (E-Invoicing
 * Resolution §2 + Annex 2.1 → VAT IR Art. 53(5)(b)), built the server-side
 * allocator, removed the browser's `INV-${Date.now()}` mint, and added
 * UNIQUE(company_id, invoice_number). Every one of those conclusions still
 * holds.
 *
 * What it did not do is check the OTHER CALLERS, because the allocator runs
 * only when the caller leaves the number blank:
 *
 *   if (!String(invData.invoiceNumber ?? "").trim()) invData.invoiceNumber = allocate()
 *
 * That `if` is an opt-out, and two ordinary product paths were taking it:
 *
 *   AUD-1  `CreditNotes.tsx` always sent `CN-${Date.now().slice(-6)}`, so every
 *          credit and debit note ran in a SECOND series — the arrangement the
 *          Resolution lists as a Prohibited Functionality — with a suffix that
 *          wraps every ~16.7 minutes onto the unique constraint.
 *   AUD-2  "Make recurring" wrote `invoiceNumber: "REC-<number>"` into the rule
 *          TEMPLATE, and the generator spreads the template into `create`. Run 1
 *          succeeded; run 2 reused the same literal and the rule failed for
 *          good.
 *
 * 🔴 The lesson these two share is the reusable part: **an invariant with an
 * opt-out is a convention.** When a rule is enforced by "we always call the
 * allocator", the CALLERS are the enforcement — so verifying the allocator
 * verifies nothing about the rule.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3131";
process.env.SESSION_SECRET ??= "document-numbering-callers-secret-0123456789";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "@workspace/db";
import { createApproved } from "./helpers/createApproved";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "doc-numbering-callers";

async function inTenant<T>(orgId: string, companyId: string, userId: number, fn: () => Promise<T>): Promise<T> {
  const { beginTenantConnection } = await import("@workspace/db");
  const { auditContext } = await import("../lib/auditContext");
  const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
  try {
    const out = await conn.run(() =>
      auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn),
    );
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  }
}

/**
 * The source-level half. These two assertions are the ones that would have
 * caught AUD-1 and AUD-2 at the moment they were written, and they cost
 * nothing to run.
 */
describe("no client path mints its own document number", () => {
  it("🔴 the credit-note form does not build a number from a clock", () => {
    const src = readFileSync(join(repoRoot, "apps", "web", "src", "pages", "CreditNotes.tsx"), "utf8");
    // The exact shape that created the second series. `Date.now()` anywhere in
    // a number field is the tell: a clock is not a sequence.
    expect(src).not.toMatch(/invoiceNumber:\s*`[^`]*Date\.now\(\)/);
  });

  it("🔴 the recurring template carries no document number — a number is not part of a pattern", () => {
    // Comments stripped first: the fix's own explanatory comment names the
    // field it removed, and matching that would make this assertion pass or
    // fail on prose rather than on code.
    const src = readFileSync(join(repoRoot, "apps", "web", "src", "pages", "Invoices.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/template:\s*\{[^}]*\binvoiceNumber\s*:/s);
  });
});

describeMaybe("the allocator's callers, exercised against real rows", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;

  const wipe = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM recurring_runs WHERE rule_id IN (SELECT id FROM recurring_rules WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM recurring_rules WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    // Approving posts a journal entry, whose lines reference `categories` —
    // so the ledger rows must go before the chart of accounts does.
    await pool.query(
      `DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id IN ${org})`,
    );
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_number_counters WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    const { rows } = await pool.query(`SELECT user_id FROM organization_memberships WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE organization_id IN ${org}`);
    for (const r of rows) await pool.query(`DELETE FROM users WHERE id = $1`, [r.user_id]);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await wipe();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status)
         VALUES ('Doc Numbering Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      // Issuing an invoice needs the company's own VAT registration (the M11.6
      // fail-closed seller identity), so the fixture supplies one.
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number)
         VALUES ($1,'Num Co','1010101019','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, password_hash, name) VALUES ($1,'x','Numberer') RETURNING id`,
        [`doc-numbering-${Date.now()}@example.test`],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role, status)
       VALUES ($1,$2,'admin','active')`,
      [orgId, userId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Numbered Customer') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(wipe);

  const line = { description: "Service", quantity: 1, unitPrice: 100, vatRate: 15 };

  it("🔴 AUD-1: a credit note left blank joins the company's ONE sequence", async () => {
    const { invoicesService } = await import("../services/invoices.service");

    const inv = await inTenant(orgId, companyId, userId, () =>
      // Approved on create: a credit note may only correct an ISSUED invoice
      // (409 `note_original_not_issued` otherwise), so the fixture has to build
      // the state the real flow builds.
      createApproved(invoicesService, { date: "2026-07-01", customerId, items: [line] } as never, userId as never),
    );
    // A credit note created the way the UI now creates one: no number supplied.
    const note = await inTenant(orgId, companyId, userId, () =>
      invoicesService.create(
        {
          date: "2026-07-02",
          customerId,
          documentType: "credit_note",
          originalInvoiceId: (inv as { id: number }).id,
          noteReason: "Returned goods",
          items: [line],
        } as never,
        userId as never,),
    );

    const invNo = (inv as { invoiceNumber: string }).invoiceNumber;
    const noteNo = (note as { invoiceNumber: string }).invoiceNumber;

    // 🔴 ONE series: consecutive counter values, not two independent runs.
    expect(invNo).toMatch(/^INV-2026-\d{6}$/);
    expect(noteNo).toMatch(/^INV-2026-\d{6}$/);
    expect(Number(noteNo.slice(-6))).toBe(Number(invNo.slice(-6)) + 1);
    // And never the shape the browser used to mint.
    expect(noteNo).not.toMatch(/^CN-/);
  });

  it("🔴 AUD-2: the SAME recurring rule generates twice, and gets two different numbers", async () => {
    /**
     * The test no recurring suite has ever run. Every existing fixture creates
     * a rule, generates ONCE, and retires it — so "a monthly rule works
     * monthly" was never measured, only "generation works".
     */
    const { recurringGenerationService } = await import("../services/recurring/generation.service");

    const template = {
      // Exactly what the "make recurring" button used to store. Kept in the
      // fixture on purpose: the FIX must hold even for a rule saved before it.
      invoiceNumber: "REC-INV-2026-000001",
      customerId,
      items: [line],
    };
    const ruleId = (
      await pool.query(
        `INSERT INTO recurring_rules
           (organization_id, company_id, entity, template, frequency, day_of_month, starts_on, next_run_on, created_by)
         VALUES ($1,$2,'invoice',$3,'monthly',1,'2026-08-01','2026-08-01',$4) RETURNING id`,
        [orgId, companyId, JSON.stringify(template), userId],
      )
    ).rows[0].id;

    const first = await recurringGenerationService.runOnce("2026-08-01", orgId);
    expect(first.generated).toBeGreaterThanOrEqual(1);

    // Make it due again — a month later, exactly as the scheduler would.
    await pool.query(`UPDATE recurring_rules SET next_run_on = '2026-09-01' WHERE id = $1`, [ruleId]);
    const second = await recurringGenerationService.runOnce("2026-09-01", orgId);
    expect(second.generated, "the second month must generate, not fail").toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(
      `SELECT invoice_number FROM invoices WHERE organization_id = $1 ORDER BY id`,
      [orgId],
    );
    const numbers = rows.map((r: { invoice_number: string }) => r.invoice_number);
    // Two generated drafts, two DIFFERENT numbers, both from the real sequence.
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.filter((n: string) => n.startsWith("REC-"))).toEqual([]);
  });
});

describeMaybe("THE SWEEP — the same mint in the documents AUD-1 did not cover", () => {
  /**
   * 🔴 AUD-1 fixed invoices and credit notes and did not sweep the shape. The
   * sweep found FIVE instances of `${PREFIX}-${Date.now().slice(-N)}`, of which
   * the fix had covered two — and the unfixed ones were worse, because none of
   * those columns has a unique index. A collision on an invoice number was
   * REFUSED; a collision on an entry or bill number was accepted silently.
   */
  let orgId = "";
  let companyId = "";
  let userId = 0;
  const SLUG2 = "doc-number-sweep";

  const wipe = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG2}')`;
    await pool.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM document_number_counters WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    const { rows } = await pool.query(`SELECT user_id FROM organization_memberships WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE organization_id IN ${org}`);
    for (const r of rows) await pool.query(`DELETE FROM users WHERE id = $1`, [r.user_id]);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG2}'`);
  };

  beforeAll(async () => {
    await wipe();
    orgId = (await pool.query(
      `INSERT INTO organizations (name, slug, verification_status) VALUES ('Sweep Org','${SLUG2}','approved') RETURNING id`,
    )).rows[0].id;
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name) VALUES ($1,'Sweep Co') RETURNING id`, [orgId],
    )).rows[0].id;
    userId = (await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1,'x','Sweeper') RETURNING id`,
      [`doc-sweep-${Date.now()}@example.test`],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES ($1,$2,'admin','active')`,
      [orgId, userId],
    );
  });

  afterAll(wipe);

  it("🔴 a BILL left blank takes the next number in its own series", async () => {
    const { billsService } = await import("../services/bills.service");
    const a = await inTenant(orgId, companyId, userId, () =>
      billsService.create({ date: "2026-08-01", total: 100, items: [] } as never, userId));
    const b = await inTenant(orgId, companyId, userId, () =>
      billsService.create({ date: "2026-08-02", total: 200, items: [] } as never, userId));
    expect((a as { billNumber: string }).billNumber).toMatch(/^BILL-\d{6}$/);
    expect(Number((b as { billNumber: string }).billNumber.slice(-6)))
      .toBe(Number((a as { billNumber: string }).billNumber.slice(-6)) + 1);
    // Never the shape the browser used to mint.
    expect((a as { billNumber: string }).billNumber).not.toMatch(/^BILL-\d{1,5}$/);
  });

  it("🔴 a JOURNAL ENTRY left blank takes the next number in a SEPARATE series", async () => {
    const { journalEntriesService } = await import("../services/journalEntries.service");
    // M13: every line must name an account, so the fixture uses the org's own
    // seeded chart rather than inventing accountless lines.
    const { rows: cats } = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 ORDER BY id LIMIT 2`, [orgId]);
    const je = await inTenant(orgId, companyId, userId, () =>
      journalEntriesService.create({
        date: "2026-08-01",
        description: "Sweep",
        lines: [
          { accountId: cats[0].id, accountName: "Cash", debitAmount: 10, creditAmount: 0 },
          { accountId: cats[1].id, accountName: "Sales", debitAmount: 0, creditAmount: 10 },
        ],
      } as never, userId));
    // Its own counter: the bill series above is at 2 and this starts at 1.
    expect((je as { entryNumber: string }).entryNumber).toBe("JE-000001");
  });

  it("a caller-supplied number is still honoured — legacy imports keep their series", async () => {
    const { billsService } = await import("../services/bills.service");
    const own = await inTenant(orgId, companyId, userId, () =>
      billsService.create({ date: "2026-08-03", billNumber: "SUPPLIER-77", total: 50, items: [] } as never, userId));
    expect((own as { billNumber: string }).billNumber).toBe("SUPPLIER-77");
  });
});
