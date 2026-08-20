/**
 * H1/H2 — the mass-assignment and amount-validation regressions (audit
 * 2026-08-20).
 *
 * Each test below is written as the ATTACK the audit described, not as a
 * paraphrase of the fix: if the allowlist or the guard is removed, these go
 * red with the exact forged state the auditor predicted. The DB CHECKs added
 * in migration 0049 are the backstop and are asserted separately, because a
 * service guard is per-path review and a new path starts at zero.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { journalEntriesService } from "../services/journalEntries.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[write-guards] no real DATABASE_URL — skipping.");

const SLUG = "h1-guards";
const EMAIL = "h1-guards@test.local";

describeMaybe("H1/H2 — a client cannot forge workflow state or post garbage amounts", () => {
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
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    for (const t of [
      "invoice_payments", "bill_payments", "journal_entry_lines", "journal_entries",
      "invoice_items", "einvoice_documents", "invoices", "bill_items", "bills",
      "customers", "vendors", "categories",
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('H1 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'H1','1010101031','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','H1',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'H1 Client') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, name_ar) VALUES ($1,'H1 Vendor','مورد') RETURNING id`, [orgId])).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  const draftInvoice = () =>
    inTenant(() =>
      invoicesService.create(
        { invoiceNumber: `H1-${Date.now()}-${Math.round(Math.random() * 1e6)}`, date: "2026-08-01", customerId, items: [{ description: "Work", quantity: 1, unitPrice: 100, vatRate: 15 }] },
        userId,
        { autoApprove: false },
      ),
    );

  it("🔴 THE ATTACK: a draft invoice PATCHed with issued-state fields stays a draft with a clean chain", async () => {
    const inv = await draftInvoice();
    await inTenant(() =>
      invoicesService.update(inv.id, {
        // Every one of these is a real column the raw spread used to accept.
        status: "sent",
        invoiceHash: "FORGED_HASH",
        previousHash: "FORGED_PREV",
        icv: 99999,
        qrCode: "FORGED_QR",
        zatcaUuid: "00000000-0000-0000-0000-000000000000",
        paidAmount: "999999",
        total: "1",
        documentType: "credit_note",
        // …plus one legitimate edit, which must still apply.
        notes: "a legitimate note",
      } as never),
    );

    const { rows: [row] } = await pool.query(
      `SELECT status, invoice_hash, previous_hash, icv, qr_code, zatca_uuid, paid_amount, total, document_type, notes
         FROM invoices WHERE id = $1`,
      [inv.id],
    );
    expect(row.status, "still a draft — approval is the only issuer").toBe("draft");
    expect(row.invoice_hash).toBeNull();
    expect(row.previous_hash).toBeNull();
    expect(row.icv, "🔴 a forged ICV could have become the chain head the next approval links to").toBeNull();
    expect(row.qr_code).toBeNull();
    expect(row.zatca_uuid).toBeNull();
    expect(Number(row.paid_amount)).toBe(0);
    expect(Number(row.total), "totals are computed, never client-supplied").toBe(115);
    expect(row.document_type).toBe("invoice");
    expect(row.notes, "the legitimate field DID apply — the allowlist is not a blanket refusal").toBe("a legitimate note");
  });

  it("🔴 THE ATTACK: a journal entry POSTed as already-posted is created as a draft", async () => {
    const { rows: [cat] } = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'CASH'`,
      [orgId],
    );
    const je = await inTenant(() =>
      journalEntriesService.create(
        {
          entryNumber: `H1-JE-${Date.now()}`,
          date: "2026-08-02",
          description: "forged",
          status: "posted",
          postedAt: new Date().toISOString(),
          lines: [
            { accountId: Number(cat.id), accountName: "Cash and Bank", debitAmount: 100, creditAmount: 0 },
            { accountId: Number(cat.id), accountName: "Cash and Bank", debitAmount: 0, creditAmount: 100 },
          ],
        } as never,
        userId,
      ),
    );
    const { rows: [row] } = await pool.query(`SELECT status, posted_at FROM journal_entries WHERE id = $1`, [je.id]);
    expect(row.status, "posting is the approval transition, never a create-time claim").toBe("draft");
    expect(row.posted_at).toBeNull();
  });

  it("🔴 THE ATTACK: NaN line amounts no longer sail through the balance check", async () => {
    // `Math.abs(NaN - NaN) > 0.01` is FALSE — the pre-fix check PASSED this and
    // the row died later as a raw 500 (or posted garbage).
    await expect(
      inTenant(() =>
        journalEntriesService.create(
          {
            entryNumber: `H1-NAN-${Date.now()}`,
            date: "2026-08-02",
            description: "nan",
            lines: [
              { accountId: 1, accountName: "X", debitAmount: "banana", creditAmount: 0 },
              { accountId: 1, accountName: "X", debitAmount: 0, creditAmount: "banana" },
            ],
          } as never,
          userId,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("negative journal amounts are refused (they balanced, and posted negatives)", async () => {
    await expect(
      inTenant(() =>
        journalEntriesService.create(
          {
            entryNumber: `H1-NEG-${Date.now()}`,
            date: "2026-08-02",
            description: "neg",
            lines: [
              { accountId: 1, accountName: "X", debitAmount: -100, creditAmount: 0 },
              { accountId: 1, accountName: "X", debitAmount: 0, creditAmount: -100 },
            ],
          } as never,
          userId,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("invoice item garbage is a named 400, not a raw 500", async () => {
    for (const bad of [
      { description: "x", quantity: -1, unitPrice: 100, vatRate: 15 },
      { description: "x", quantity: "banana", unitPrice: 100, vatRate: 15 },
      { description: "x", quantity: 1, unitPrice: 100, vatRate: 999 },
    ]) {
      await expect(
        inTenant(() =>
          invoicesService.create(
            { invoiceNumber: `H1-BAD-${Date.now()}-${Math.random()}`, date: "2026-08-01", customerId, items: [bad] } as never,
            userId,
            { autoApprove: false },
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("an invalid date is refused rather than persisted as text that evades period locks", async () => {
    for (const date of ["banana", "2026-13-40"]) {
      await expect(
        inTenant(() =>
          invoicesService.create(
            { invoiceNumber: `H1-DATE-${Date.now()}-${Math.random()}`, date, customerId, items: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 15 }] } as never,
            userId,
            { autoApprove: false },
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("🔴 THE ATTACK: a bill cannot be created pre-approved (it would be payable with no AP posted)", async () => {
    const bill = await inTenant(() =>
      billsService.create(
        { billNumber: `H1-B-${Date.now()}`, date: "2026-08-03", vendorId, status: "approved", paidAmount: "500", subtotal: 100, vatAmount: 15, total: 115, items: [] } as never,
        userId,
      ),
    );
    const { rows: [row] } = await pool.query(`SELECT status, paid_amount FROM bills WHERE id = $1`, [bill.id]);
    expect(row.status).toBe("draft");
    expect(Number(row.paid_amount)).toBe(0);
  });

  it("🔴 THE BACKSTOP: the DB refuses a negative journal line even if a future path skips the service", async () => {
    // migration 0049 — an invariant several writers can violate belongs at the
    // write boundary, not in per-path code.
    const { rows: [je] } = await pool.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
       VALUES ($1,$2,'H1-RAW','2026-08-04','raw','draft') RETURNING id`,
      [orgId, companyId],
    );
    await expect(
      pool.query(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_name, debit_amount, credit_amount)
         VALUES ($1,$2,$3,'X',-50,0)`,
        [orgId, companyId, je.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("🔴 THE BACKSTOP: the DB refuses an out-of-range VAT rate on an invoice item", async () => {
    const inv = await draftInvoice();
    await expect(
      pool.query(
        `INSERT INTO invoice_items (organization_id, company_id, invoice_id, description, quantity, unit_price, vat_rate, total)
         VALUES ($1,$2,$3,'X',1,100,999,100)`,
        [orgId, companyId, inv.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
