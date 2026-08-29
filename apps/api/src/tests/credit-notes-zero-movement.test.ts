/**
 * Credit / debit notes — ZERO-MOVEMENT proof + reversal correctness (M12.1b).
 *
 * The M10 template applied to notes, plus the two properties unique to them:
 *
 *   1. A DRAFT note moves ZERO across every money report — AR aging,
 *      balance-sheet AR, the VAT return and the customer ledger — and approval
 *      is what posts it. Same standard as every other financial record.
 *
 *   2. 🔴 A CREDIT note REVERSES; a DEBIT note does NOT. A debit note is an
 *      additional charge, so it posts in the same direction as an invoice.
 *      Treating both as reversals would understate AR and output VAT.
 *
 * It also pins the two report bugs that made NEGATIVE storage untenable, in the
 * direction that would fail if someone "simplified" the sign handling away:
 *   - AR aging must not skip the note (`outstanding < 0.01` → `continue`);
 *   - the VAT return must REDUCE output VAT, not divert the note into the
 *     zero-rated box.
 *
 * Needs a real database; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { customersService } from "../services/customers.service";
import { reportsService } from "../services/reports.service";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[credit-notes] no real DATABASE_URL — skipping zero-movement test.");

describeMaybe("Credit/debit notes — zero movement until approved, then correct direction", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let originalId = 0;

  const DATE = "2026-07-15";
  const PERIOD = "2026-07";
  // Original invoice: 1000 + 150 VAT = 1150.
  const SUBTOTAL = 1000;
  const VAT = 150;
  const TOTAL = 1150;
  // Credit note: 200 + 30 VAT = 230.
  const CN_SUBTOTAL = 200;
  const CN_VAT = 30;
  const CN_TOTAL = 230;

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

  /**
   * Cleanup keyed on the SLUG and EMAIL, never on the in-memory ids.
   *
   * Those ids are empty on a fresh process, so a run aborted part-way (a failing
   * `beforeAll`, an interrupted suite) left rows that the next run could not
   * delete — and every subsequent run then failed in `beforeAll` with a foreign
   * key violation. Resolving the ids from the database makes cleanup idempotent
   * and self-healing.
   */
  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = 'cn-appr')`;
    const usr = `(SELECT id FROM users WHERE email = 'cn-approval@test.local')`;

    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    // Notes reference invoices, so delete NOTES FIRST, then the originals.
    // (Nulling `original_invoice_id` instead would violate
    // `invoices_note_reference_chk` — a note must always carry its reference.
    // The constraint catching that is the constraint working.)
    await pool.query(
      `DELETE FROM invoices WHERE organization_id IN ${org} AND document_type <> 'invoice'`,
    );
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM period_locks WHERE organization_id IN ${org}`);
    // audit_logs references BOTH the org and the user — clear by either, or the
    // user delete below hits a foreign key.
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = 'cn-approval@test.local'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'cn-appr'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('CN Org','cn-appr') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'CN Co','1010101010','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('cn-approval@test.local','CN Approver',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(
        `INSERT INTO customers (organization_id, name, name_ar, tax_number) VALUES ($1,'Gamma Client','جاما','300000000000003') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;

    // The original invoice, issued (self-approve on create as an approver).
    const inv = await inTenant(() =>
      createApproved(invoicesService, {
          invoiceNumber: "INV-CN-1",
          date: DATE,
          dueDate: DATE,
          customerId,
          items: [{ description: "Widgets", quantity: 10, unitPrice: 100, vatRate: 15 }],
        },
        userId),
    );
    originalId = inv.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  /**
   * AR, output VAT and the customer balance as the books currently see them.
   *
   * 🔴 Read INSIDE the tenant transaction. Outside one, `db` resolves to the
   * owner connection, which BYPASSES RLS — so the reports would sum every
   * organization's invoices and this suite would silently depend on whatever
   * other suites happen to have in the database at the time. (That is the
   * failure mode: it passed alone and failed in the full run.)
   */
  async function books() {
    const [ar, bs, vat, cust] = await inTenant(async () =>
      Promise.all([
        reportsService.arAging(),
        reportsService.balanceSheet(),
        reportsService.vatReturn(PERIOD, PERIOD),
        customersService.getById(customerId),
      ]),
    );
    return {
      arAging: ar.total,
      balanceSheetAR: bs.assets.accountsReceivable,
      outputVat: vat.salesSection.box8_totalOutputVat,
      standardRatedSales: vat.salesSection.box1_standardRatedDomesticSales,
      customerBalance: cust.balance,
    };
  }

  it("the original invoice is in the books, with an ICV and a UUID assigned", async () => {
    const b = await books();
    expect(b.arAging).toBe(TOTAL);
    expect(b.balanceSheetAR).toBe(TOTAL);
    expect(b.outputVat).toBe(VAT);
    expect(b.customerBalance).toBe(TOTAL);

    // M12.1b: issuance now assigns these. Before, they were always NULL and the
    // whole ZATCA Phase-2 pipeline was unreachable from real data.
    const { rows } = await pool.query(`SELECT icv, zatca_uuid, invoice_hash FROM invoices WHERE id = $1`, [originalId]);
    expect(rows[0].icv).toBe(1);
    expect(rows[0].zatca_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].invoice_hash).toBeTruthy();
  });

  let creditNoteId = 0;

  it("a DRAFT credit note moves ZERO in every money report", async () => {
    const before = await books();

    const note = await inTenant(() =>
      invoicesService.create(
        {
          invoiceNumber: "CN-1",
          date: DATE,
          customerId,
          documentType: "credit_note",
          originalInvoiceId: originalId,
          noteReason: "Goods returned",
          items: [{ description: "Returned widgets", quantity: 2, unitPrice: 100, vatRate: 15 }],
        },
        userId),
    );
    creditNoteId = note.id;

    const after = await books();
    expect(after, "a draft note must not touch the books").toEqual(before);

    // And it consumed no sequence position.
    const { rows } = await pool.query(`SELECT icv, invoice_hash, status FROM invoices WHERE id = $1`, [creditNoteId]);
    expect(rows[0].status).toBe("draft");
    expect(rows[0].icv).toBeNull();
    expect(rows[0].invoice_hash).toBeNull();
  });

  it("SUBMITTED is still zero — the queue is not the books", async () => {
    const before = await books();
    await inTenant(() => invoicesService.submit(creditNoteId, userId));
    expect(await books()).toEqual(before);
  });

  it("🔴 APPROVAL posts the REVERSAL: AR down, output VAT down, sales down", async () => {
    await inTenant(() => invoicesService.approve(creditNoteId, userId));
    const b = await books();

    // AR aging must NOT skip the note. If the `outstanding < 0.01` guard were
    // applied to the signed value, this would still read TOTAL and silently
    // diverge from balance-sheet AR.
    expect(b.arAging, "AR aging").toBe(TOTAL - CN_TOTAL);
    expect(b.balanceSheetAR, "balance-sheet AR").toBe(TOTAL - CN_TOTAL);
    expect(b.customerBalance, "customer balance").toBe(TOTAL - CN_TOTAL);

    // The VAT return must REDUCE output VAT — not divert the note into the
    // zero-rated box, which is what a negative stored amount would have done.
    expect(b.outputVat, "output VAT").toBe(VAT - CN_VAT);
    expect(b.standardRatedSales, "standard-rated sales").toBe(SUBTOTAL - CN_SUBTOTAL);
  });

  it("the credit note's GL entry is REVERSED (Dr Sales + Dr VAT / Cr AR)", async () => {
    const { rows } = await pool.query(
      `SELECT l.account_name, l.debit_amount::numeric AS debit, l.credit_amount::numeric AS credit
         FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.organization_id = $1 AND e.reference = 'CN-1'
        ORDER BY l.account_name`,
      [orgId],
    );
    const by = Object.fromEntries(rows.map((r) => [r.account_name, r]));

    expect(Number(by["Accounts Receivable"].credit)).toBe(CN_TOTAL);
    expect(Number(by["Accounts Receivable"].debit)).toBe(0);
    expect(Number(by["Sales Revenue"].debit)).toBe(CN_SUBTOTAL);
    expect(Number(by["VAT Payable"].debit)).toBe(CN_VAT);

    // Amounts are stored POSITIVE; only the direction differs.
    const inv = await pool.query(`SELECT total::numeric AS total FROM invoices WHERE id = $1`, [creditNoteId]);
    expect(Number(inv.rows[0].total)).toBe(CN_TOTAL);
  });

  it("🔴 a DEBIT note posts in the SAME direction as an invoice — it is NOT a reversal", async () => {
    const before = await books();

    const dn = await inTenant(() =>
      createApproved(invoicesService, {
          invoiceNumber: "DN-1",
          date: DATE,
          customerId,
          documentType: "debit_note",
          originalInvoiceId: originalId,
          noteReason: "Price correction — undercharged freight",
          items: [{ description: "Freight adjustment", quantity: 1, unitPrice: 100, vatRate: 15 }],
        },
        userId),
    );

    const after = await books();
    // A debit note is an ADDITIONAL CHARGE: AR and output VAT go UP.
    expect(after.arAging).toBe(before.arAging + 115);
    expect(after.balanceSheetAR).toBe(before.balanceSheetAR + 115);
    expect(after.outputVat).toBe(before.outputVat + 15);
    expect(after.customerBalance).toBe(before.customerBalance + 115);

    const { rows } = await pool.query(
      `SELECT l.account_name, l.debit_amount::numeric AS debit
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.organization_id = $1 AND e.reference = 'DN-1' AND l.account_name = 'Accounts Receivable'`,
      [orgId],
    );
    expect(Number(rows[0].debit), "a debit note DEBITS AR, like an invoice").toBe(115);
    void dn;
  });

  it("notes share ONE ICV sequence and ONE hash chain with invoices", async () => {
    const { rows } = await pool.query(
      `SELECT invoice_number, icv, previous_hash, invoice_hash
         FROM invoices WHERE organization_id = $1 AND icv IS NOT NULL ORDER BY icv`,
      [orgId],
    );
    // ZATCA's counter is per EGS unit and covers every document type.
    expect(rows.map((r) => r.invoice_number)).toEqual(["INV-CN-1", "CN-1", "DN-1"]);
    expect(rows.map((r) => r.icv)).toEqual([1, 2, 3]);

    // Each link points at its predecessor — one chain, no fork.
    expect(rows[1].previous_hash).toBe(rows[0].invoice_hash);
    expect(rows[2].previous_hash).toBe(rows[1].invoice_hash);
  });

  it("rejects a note with no reason (BR-KSA-17) and no original", async () => {
    await expect(
      inTenant(() =>
        invoicesService.create(
          {
            invoiceNumber: "CN-BAD-1",
            date: DATE,
            customerId,
            documentType: "credit_note",
            originalInvoiceId: originalId,
            items: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 15 }],
          },
          userId,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 400, payload: { code: "note_reason_required" } });

    await expect(
      inTenant(() =>
        invoicesService.create(
          {
            invoiceNumber: "CN-BAD-2",
            date: DATE,
            customerId,
            documentType: "credit_note",
            noteReason: "No original",
            items: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 15 }],
          },
          userId,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 400, payload: { code: "note_original_required" } });
  });

  it("refuses to over-credit, naming the total and what is already credited", async () => {
    const err = await inTenant(() =>
      invoicesService.create(
        {
          invoiceNumber: "CN-OVER",
          date: DATE,
          customerId,
          documentType: "credit_note",
          originalInvoiceId: originalId,
          noteReason: "Full refund attempt",
          // 1150 invoiced, 230 already credited ⇒ 920 remains. Ask for 1150.
          items: [{ description: "Too much", quantity: 10, unitPrice: 100, vatRate: 15 }],
        },
        userId,
      ),
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ statusCode: 409, payload: { code: "note_over_credit" } });
    const payload = (err as { payload: Record<string, string> }).payload;
    expect(payload.originalTotal).toBe("1150.00");
    expect(payload.alreadyCredited).toBe("230.00");
    expect(payload.remaining).toBe("920.00");
  });

  it("refuses a note against a DRAFT invoice — there is nothing in the books to correct", async () => {
    const draft = await inTenant(() =>
      invoicesService.create(
        {
          invoiceNumber: "INV-DRAFT-1",
          date: DATE,
          customerId,
          items: [{ description: "y", quantity: 1, unitPrice: 50, vatRate: 15 }],
        },
        userId),
    );

    await expect(
      inTenant(() =>
        invoicesService.create(
          {
            invoiceNumber: "CN-VS-DRAFT",
            date: DATE,
            customerId,
            documentType: "credit_note",
            originalInvoiceId: draft.id,
            noteReason: "Against a draft",
            items: [{ description: "z", quantity: 1, unitPrice: 10, vatRate: 15 }],
          },
          userId,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 409, payload: { code: "note_original_not_issued" } });
  });

  it("a note against an invoice in a CLOSED period is allowed; the note's OWN date governs", async () => {
    // Close the original's period. The note is dated in an OPEN one.
    await pool.query(
      `INSERT INTO period_locks (organization_id, company_id, period, locked_by) VALUES ($1,$2,$3,$4)`,
      [orgId, companyId, PERIOD, userId],
    );
    try {
      // Dating the note INTO the closed period is refused...
      await expect(
        inTenant(() =>
          invoicesService.create(
            {
              invoiceNumber: "CN-CLOSED",
              date: DATE,
              customerId,
              documentType: "credit_note",
              originalInvoiceId: originalId,
              noteReason: "Late return",
              items: [{ description: "late", quantity: 1, unitPrice: 10, vatRate: 15 }],
            },
            userId,
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 423 });

      // ...but correcting it in the CURRENT open period is fine, even though the
      // ORIGINAL sits in a closed one. That is standard practice: you never post
      // into a closed period, you post the correction in an open one.
      const ok = await inTenant(() =>
        createApproved(invoicesService, {
            invoiceNumber: "CN-OPEN",
            date: "2026-08-10",
            customerId,
            documentType: "credit_note",
            originalInvoiceId: originalId,
            noteReason: "Late return, corrected in August",
            items: [{ description: "late", quantity: 1, unitPrice: 10, vatRate: 15 }],
          },
          userId),
      );
      expect(ok.status).toBe("sent");
    } finally {
      await pool.query(`DELETE FROM period_locks WHERE organization_id = $1`, [orgId]);
    }
  });

  it("records every note transition in the audit trail", async () => {
    const { rows } = await pool.query(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'invoice'`,
      [orgId],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("create");
    expect(actions).toContain("submit");
    expect(actions).toContain("approve");
  });
});
